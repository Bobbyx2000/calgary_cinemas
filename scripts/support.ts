import { DateTime } from "luxon";
import * as cheerio from "cheerio";
import type {
  Listing,
  ListingKind,
  ListingsPayload,
  ProviderWarning,
  Showtime,
  Theatre
} from "../src/lib/types";

export const SHOWTIME_TIME_ZONE = "America/Edmonton" as const;
export const PLAZA_SOURCE_URL =
  "https://ticketing.uswest.veezi.com/sessions/?siteToken=9xj6mkn8fmb6cv01mats3y1zgr";
export const GLOBE_SOURCE_URL = "https://globecinema.ca/movie.html";
export const GRAND_SOURCE_URL = "https://www.thegrandyyc.ca/whats-on";
export const CONTEMPORARY_CALGARY_SOURCE_URL =
  "https://www.contemporarycalgary.com/learn-more-perspective-film-series";

type FetchLike = typeof fetch;

type PartialListing = {
  title: string;
  rating: string | null;
  posterURL: string | null;
  showtimes: Showtime[];
};

type FilmMetadata = {
  rating: string | null;
  summary: string | null;
  posterURL: string | null;
  showtimes: Showtime[];
};

type GrandCandidate = {
  title: string;
  dateText: string;
  detailURL: string;
  posterURL: string | null;
  purchaseURL: string | null;
};

type ContemporaryCandidate = {
  title: string;
  detailURL: string;
  posterURL: string | null;
};

type ProviderDefinition = {
  sourceName: string;
  sourceURL: string;
  fetchListings: (fetchImpl: FetchLike, referenceDate: Date) => Promise<Listing[]>;
};

const providers: ProviderDefinition[] = [
  {
    sourceName: "The Plaza Theatre",
    sourceURL: PLAZA_SOURCE_URL,
    fetchListings: async (fetchImpl, referenceDate) =>
      parsePlazaHTML(await fetchHTML(PLAZA_SOURCE_URL, fetchImpl), referenceDate)
  },
  {
    sourceName: "Globe Cinema",
    sourceURL: GLOBE_SOURCE_URL,
    fetchListings: async (fetchImpl, referenceDate) =>
      parseGlobeHTML(await fetchHTML(GLOBE_SOURCE_URL, fetchImpl), referenceDate)
  },
  {
    sourceName: "The GRAND",
    sourceURL: GRAND_SOURCE_URL,
    fetchListings: async (fetchImpl, referenceDate) =>
      parseGrandHTML(
        await fetchHTML(GRAND_SOURCE_URL, fetchImpl),
        fetchImpl,
        referenceDate
      )
  },
  {
    sourceName: "Contemporary Calgary",
    sourceURL: CONTEMPORARY_CALGARY_SOURCE_URL,
    fetchListings: async (fetchImpl, referenceDate) =>
      parseContemporaryCalgaryHTML(
        await fetchHTML(CONTEMPORARY_CALGARY_SOURCE_URL, fetchImpl),
        fetchImpl,
        referenceDate
      )
  }
];

export async function refreshListings(
  fetchImpl: FetchLike = fetch,
  referenceDate = new Date()
): Promise<ListingsPayload> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        return {
          listings: await provider.fetchListings(fetchImpl, referenceDate),
          warning: null
        };
      } catch (error) {
        return {
          listings: [] as Listing[],
          warning: {
            sourceName: provider.sourceName,
            message:
              error instanceof Error ? error.message : "Unknown provider failure"
          } satisfies ProviderWarning
        };
      }
    })
  );

  const listings = sortListings(results.flatMap((result) => result.listings));
  const warnings = results
    .flatMap((result) => result.warning)
    .filter((warning): warning is ProviderWarning => warning !== null)
    .sort((left, right) => left.sourceName.localeCompare(right.sourceName));

  return {
    generatedAt: new Date().toISOString(),
    timeZone: SHOWTIME_TIME_ZONE,
    listingCount: listings.length,
    warnings,
    listings
  };
}

export async function fetchHTML(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new Error(`The source at ${new URL(url).host} returned ${response.status}.`);
  }

  return response.text();
}

export function parsePlazaHTML(html: string, referenceDate = new Date()): Listing[] {
  const $ = cheerio.load(html, { baseURI: PLAZA_SOURCE_URL });
  const metadataByTitle = parsePlazaFilmMetadata($, referenceDate);
  const listingsByTitle = new Map<string, PartialListing>();

  $("#sessionsByDateConent > div.date > div.film").each((_, element) => {
    const film = $(element);
    const title = normalizeWhitespace(film.find("h3.title").first().text());

    if (!title) {
      return;
    }

    const rating = nilIfBlank(normalizeWhitespace(film.find("p").first().text()));
    const posterValue = film.find("img.poster").first().attr("src") ?? "";
    const posterURL = resolveURL(posterValue, PLAZA_SOURCE_URL);
    const dateText = nilIfBlank(
      normalizeWhitespace(film.find("div.date-container > h4.date").first().text())
    );

    const showtimes = film
      .find("ul.session-times a")
      .toArray()
      .flatMap((anchor) => {
        const timeText = normalizeWhitespace($(anchor).find("time").text());
        if (!dateText) {
          return [];
        }

        const startsAt = parsePlazaDate(dateText, timeText, referenceDate);

        if (!startsAt) {
          return [];
        }

        const ticketURL = resolveURL($(anchor).attr("href") ?? "", PLAZA_SOURCE_URL);
        return [buildShowtime(startsAt, ticketURL)];
      });

    const key = title.toLowerCase();
    const existing = listingsByTitle.get(key);

    listingsByTitle.set(key, {
      title,
      rating: rating ?? existing?.rating ?? null,
      posterURL: posterURL ?? existing?.posterURL ?? null,
      showtimes: uniqueSortedShowtimes([...(existing?.showtimes ?? []), ...showtimes])
    });
  });

  const listings = Array.from(listingsByTitle.values())
    .map<Listing | null>((partial) => {
      const metadata = metadataByTitle.get(partial.title.toLowerCase());
      const mergedShowtimes = uniqueSortedShowtimes(
        partial.showtimes.length > 0 ? partial.showtimes : metadata?.showtimes ?? []
      );

      if (mergedShowtimes.length === 0) {
        return null;
      }

      return {
        id: normalizedListingID("plaza", partial.title),
        title: partial.title,
        kind: "movie" as const,
        theatre: "plaza" as const,
        rating: partial.rating ?? metadata?.rating ?? null,
        summary: metadata?.summary ?? null,
        posterURL: partial.posterURL ?? metadata?.posterURL ?? null,
        purchaseURL:
          mergedShowtimes.find((showtime) => showtime.ticketURL)?.ticketURL ?? null,
        sourceURL: PLAZA_SOURCE_URL,
        showtimes: mergedShowtimes
      } satisfies Listing;
    })
    .filter((listing): listing is Listing => listing !== null);

  return sortListings(listings);
}

export function parseGlobeHTML(html: string, referenceDate = new Date()): Listing[] {
  const $ = cheerio.load(html, { baseURI: GLOBE_SOURCE_URL });
  const posterColumns = $('div.col_two_fifth[id]').toArray();
  const detailColumns = $("div.col_three_fifth.col_last.bottmmargin-lg.dark").toArray();
  const listings: Listing[] = [];
  const pairCount = Math.min(posterColumns.length, detailColumns.length);

  for (let index = 0; index < pairCount; index += 1) {
    const posterColumn = $(posterColumns[index]);
    const detailColumn = $(detailColumns[index]);
    const title = normalizeWhitespace(
      detailColumn.find("div.entry-title h3 a").first().text()
    );

    if (!title) {
      continue;
    }

    const anchorId = posterColumn.attr("id") ?? "";
    const posterURL = resolveURL(
      posterColumn.find('a[data-lightbox="image"] img').first().attr("src") ?? "",
      GLOBE_SOURCE_URL
    );
    const entryContent = detailColumn.find("div.entry-content").first();
    const action = extractAction(entryContent, $);
    const summary = cleanSummary(entryContent.text());
    const rating = summary ? extractMetadataValue("Rating:", summary) : null;
    const showtimes = detailColumn
      .find("div.togglec li")
      .toArray()
      .flatMap((item) => {
        const startsAt = parseGlobeDate(normalizeWhitespace($(item).text()), referenceDate);
        return startsAt ? [buildShowtime(startsAt, action?.url ?? null)] : [];
      });

    if (showtimes.length === 0) {
      continue;
    }

    const sourceURL = new URL(`#${anchorId}`, GLOBE_SOURCE_URL).toString();
    const kind = inferKind(title, summary, action?.label ?? null, showtimes);

    listings.push({
      id: normalizedListingID("globe", title),
      title,
      kind,
      theatre: "globe",
      rating,
      summary,
      posterURL,
      purchaseURL: action?.url ?? null,
      sourceURL,
      showtimes: uniqueSortedShowtimes(showtimes)
    });
  }

  return sortListings(listings);
}

export async function parseGrandHTML(
  html: string,
  fetchImpl: FetchLike,
  referenceDate = new Date()
): Promise<Listing[]> {
  const $ = cheerio.load(html, { baseURI: GRAND_SOURCE_URL });
  const candidates = parseGrandCandidates($);
  const listings = await Promise.all(
    candidates.map(async (candidate): Promise<Listing | null> => {
      const detailHTML = await fetchHTML(candidate.detailURL, fetchImpl);
      const detail = parseGrandDetail(detailHTML, candidate.dateText, referenceDate);

      if (!detail) {
        return null;
      }

      const showtime = buildShowtime(detail.startsAt, candidate.purchaseURL);

      return {
        id: normalizedListingID("grand", candidate.title),
        title: candidate.title,
        kind: "movie" as const,
        theatre: "grand",
        rating: detail.rating,
        summary: detail.summary,
        posterURL: candidate.posterURL,
        purchaseURL: candidate.purchaseURL,
        sourceURL: candidate.detailURL,
        showtimes: [showtime]
      } satisfies Listing;
    })
  );

  return sortListings(listings.filter((listing): listing is Listing => listing !== null));
}

export async function parseContemporaryCalgaryHTML(
  html: string,
  fetchImpl: FetchLike,
  referenceDate = new Date()
): Promise<Listing[]> {
  const $ = cheerio.load(html, { baseURI: CONTEMPORARY_CALGARY_SOURCE_URL });
  const candidates = parseContemporaryCalgaryCandidates($, referenceDate);
  const listings = await Promise.all(
    candidates.map(async (candidate): Promise<Listing | null> => {
      const detailHTML = await fetchHTML(candidate.detailURL, fetchImpl);
      const detail = parseContemporaryCalgaryDetail(detailHTML);

      if (!detail) {
        return null;
      }

      const showtime = buildShowtime(detail.startsAt, detail.purchaseURL);

      return {
        id: normalizedListingID("contemporary", candidate.title),
        title: candidate.title,
        kind: "movie" as const,
        theatre: "contemporary",
        rating: null,
        summary: detail.summary,
        posterURL: detail.posterURL ?? candidate.posterURL,
        purchaseURL: detail.purchaseURL,
        sourceURL: candidate.detailURL,
        showtimes: [showtime]
      } satisfies Listing;
    })
  );

  return sortListings(listings.filter((listing): listing is Listing => listing !== null));
}

export function parseGrandDate(
  dateText: string,
  timeText: string,
  referenceDate = new Date()
): Date | null {
  const reference = DateTime.fromJSDate(referenceDate, { zone: SHOWTIME_TIME_ZONE });
  const candidate = DateTime.fromFormat(
    `${normalizeWhitespace(dateText)} ${normalizeGrandTime(timeText)}`,
    "MMM dd, yyyy h:mm a",
    {
      zone: SHOWTIME_TIME_ZONE,
      locale: "en-US"
    }
  );

  if (!candidate.isValid) {
    return null;
  }

  const diffDays = Math.abs(candidate.diff(reference, "days").days);
  return diffDays <= 365 ? candidate.toJSDate() : null;
}

export function parsePlazaDate(
  dateText: string,
  timeText: string,
  referenceDate = new Date()
): Date | null {
  return parseInferredDate(dateText, "EEEE d, MMMM", timeText, "h:mm a", referenceDate);
}

export function parseGlobeDate(showtime: string, referenceDate = new Date()): Date | null {
  const parts = showtime.split(" - ");

  if (parts.length !== 2) {
    return null;
  }

  return parseInferredDate(
    normalizeWhitespace(parts[0]),
    "MMMM d",
    normalizeWhitespace(parts[1]).toUpperCase(),
    "h:mma",
    referenceDate
  );
}

function parsePlazaFilmMetadata(
  $: cheerio.CheerioAPI,
  referenceDate: Date
): Map<string, FilmMetadata> {
  const metadataByTitle = new Map<string, FilmMetadata>();

  $("#sessionsByFilmConent > div.film").each((_, element) => {
    const film = $(element);
    const title = normalizeWhitespace(film.find("h3.title").first().text());

    if (!title) {
      return;
    }

    const rating = nilIfBlank(normalizeWhitespace(film.find("p").first().text()));
    const summary = nilIfBlank(normalizeWhitespace(film.find("p.film-desc").first().text()));
    const posterURL = resolveURL(film.find("img.poster").first().attr("src") ?? "", PLAZA_SOURCE_URL);
    const showtimes = film
      .find("div.date-container")
      .toArray()
      .flatMap((container) => {
        const dateText = nilIfBlank(
          normalizeWhitespace($(container).find("h4.date").first().text())
        );

        if (!dateText) {
          return [];
        }

        return $(container)
          .find("ul.session-times a")
          .toArray()
          .flatMap((anchor) => {
            const timeText = normalizeWhitespace($(anchor).find("time").text());
            const startsAt = parsePlazaDate(dateText, timeText, referenceDate);

            if (!startsAt) {
              return [];
            }

            const ticketURL = resolveURL($(anchor).attr("href") ?? "", PLAZA_SOURCE_URL);
            return [buildShowtime(startsAt, ticketURL)];
          });
      });

    metadataByTitle.set(title.toLowerCase(), {
      rating,
      summary,
      posterURL,
      showtimes: uniqueSortedShowtimes(showtimes)
    });
  });

  return metadataByTitle;
}

function parseGrandCandidates($: cheerio.CheerioAPI): GrandCandidate[] {
  return $(".event-listing-col")
    .toArray()
    .flatMap((element) => {
      const card = $(element);
      const title = normalizeWhitespace(card.find(".event-title").first().text());
      const dateText = normalizeWhitespace(card.find(".event-dates").first().text());
      const detailHref =
        card.find("a.title-link[href]").first().attr("href") ??
        card.find("a.img-hvr[href]").first().attr("href") ??
        "";
      const detailURL = resolveURL(detailHref, GRAND_SOURCE_URL);

      if (!title || !dateText || !detailURL || !isInternalURL(detailURL, GRAND_SOURCE_URL)) {
        return [];
      }

      const rawPosterURL = normalizeWhitespace(
        card.find("img.card-img").first().attr("src") ?? ""
      );
      const posterURL = resolveURL(rawPosterURL, GRAND_SOURCE_URL);
      const ticketLink = card.find("a.event_listing_ticket_link").first();

      return [
        {
          title,
          dateText,
          detailURL,
          posterURL,
          purchaseURL: extractGrandPurchaseURL(ticketLink, $)
        }
      ];
    });
}

function parseContemporaryCalgaryCandidates(
  $: cheerio.CheerioAPI,
  referenceDate: Date
): ContemporaryCandidate[] {
  const reference = DateTime.fromJSDate(referenceDate, { zone: SHOWTIME_TIME_ZONE }).startOf(
    "day"
  );

  return $(".summary-item-record-type-event")
    .toArray()
    .flatMap((element) => {
      const card = $(element);
      const title = normalizeWhitespace(
        card.find(".summary-title-link").first().text() ||
          card.find(".summary-thumbnail-container").first().attr("data-title") ||
          ""
      );
      const detailHref =
        card.find(".summary-title-link[href]").first().attr("href") ??
        card.find(".summary-thumbnail-container[href]").first().attr("href") ??
        "";
      const detailURL = resolveURL(detailHref, CONTEMPORARY_CALGARY_SOURCE_URL);
      const dateText = normalizeWhitespace(
        card.find("time.summary-metadata-item--date").first().text()
      );
      const startsOn = DateTime.fromFormat(dateText, "MMMM d, yyyy", {
        zone: SHOWTIME_TIME_ZONE,
        locale: "en-US"
      });

      if (
        !title.includes("Perspective Film Series") ||
        !detailURL ||
        !isInternalURL(detailURL, CONTEMPORARY_CALGARY_SOURCE_URL) ||
        !startsOn.isValid ||
        startsOn.toMillis() < reference.toMillis() ||
        startsOn.diff(reference, "days").days > 365
      ) {
        return [];
      }

      return [
        {
          title,
          detailURL,
          posterURL: resolveURL(
            card.find("img.summary-thumbnail-image").first().attr("data-image") ??
              card.find("img.summary-thumbnail-image").first().attr("data-src") ??
              card.find("img.summary-thumbnail-image").first().attr("src") ??
              "",
            CONTEMPORARY_CALGARY_SOURCE_URL
          )
        }
      ];
    });
}

function parseGrandDetail(
  html: string,
  dateText: string,
  referenceDate: Date
): { startsAt: Date; rating: string | null; summary: string | null } | null {
  const $ = cheerio.load(html, { baseURI: GRAND_SOURCE_URL });
  const detailText = normalizeWhitespace($("body").text() || $.root().text());

  if (!isGrandMovieDetail(detailText)) {
    return null;
  }

  const movieStartText = extractGrandMovieStart(detailText);

  if (!movieStartText) {
    return null;
  }

  const startsAt = parseGrandDate(dateText, movieStartText, referenceDate);

  if (!startsAt) {
    return null;
  }

  return {
    startsAt,
    rating: extractGrandRating(detailText),
    summary: extractGrandSummary(detailText)
  };
}

function isGrandMovieDetail(detailText: string): boolean {
  const hasMovieStart = /Movie starts:/i.test(detailText);
  const hasFeatureScreening = /Feature Film Screening:/i.test(detailText);
  const hasFilmMetadata = /(Directed by|Rating:|Trailer:)/i.test(detailText);

  return hasMovieStart || (hasFeatureScreening && hasFilmMetadata);
}

function extractGrandMovieStart(detailText: string): string | null {
  const match = detailText.match(/Movie starts:\s*([0-9]{1,2}:[0-9]{2}\s*[AP]M)/i);
  return match ? normalizeGrandTime(match[1]) : null;
}

function extractGrandPurchaseURL(
  ticketLink: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI
): string | null {
  const href = ticketLink.attr("href") ?? "";
  const resolvedHref = resolveURL(href, GRAND_SOURCE_URL);

  if (resolvedHref && href !== "#" && !isInternalURL(resolvedHref, GRAND_SOURCE_URL)) {
    return resolvedHref;
  }

  const onclick = ticketLink.attr("onclick") ?? "";
  const showpassSlug = onclick.match(/eventPurchaseWidget\('([^']+)/)?.[1]?.split(",")[0];

  if (!showpassSlug) {
    return null;
  }

  return `https://www.showpass.com/${showpassSlug.replace(/^\/+|\/+$/g, "")}/`;
}

function extractGrandRating(detailText: string): string | null {
  const match = detailText.match(
    /Rating:\s*(PG-13|NC-17|UNRATED|STC|18A|14A|PG|NR|R|G)/i
  );
  return match ? normalizeWhitespace(match[1].toUpperCase()) : null;
}

function extractGrandSummary(detailText: string): string | null {
  const beforeEventDetails = detailText.split(/Event details/i)[0] ?? detailText;
  const ratingMatch = beforeEventDetails.match(
    /Rating:\s*(PG-13|NC-17|UNRATED|STC|18A|14A|PG|NR|R|G)/i
  );
  const afterRating =
    ratingMatch && ratingMatch.index !== undefined
      ? beforeEventDetails.slice(ratingMatch.index + ratingMatch[0].length)
      : beforeEventDetails;

  return nilIfBlank(afterRating);
}

function normalizeGrandTime(timeText: string): string {
  return normalizeWhitespace(timeText).replace(/\s*([AP])M$/i, " $1M").toUpperCase();
}

function parseContemporaryCalgaryDetail(html: string): {
  startsAt: Date;
  posterURL: string | null;
  purchaseURL: string | null;
  summary: string | null;
} | null {
  const $ = cheerio.load(html, { baseURI: CONTEMPORARY_CALGARY_SOURCE_URL });
  const eventData = extractContemporaryCalgaryEventData($);

  if (!eventData) {
    return null;
  }

  return {
    startsAt: eventData.startsAt,
    posterURL: eventData.posterURL,
    purchaseURL: extractContemporaryCalgaryPurchaseURL($),
    summary: extractContemporaryCalgarySummary($)
  };
}

function extractContemporaryCalgaryEventData($: cheerio.CheerioAPI): {
  startsAt: Date;
  posterURL: string | null;
} | null {
  const structuredData = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((element) => {
      const rawValue = $(element).contents().text().trim();

      if (!rawValue) {
        return [];
      }

      try {
        const parsed = JSON.parse(rawValue) as unknown;
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });

  for (const candidate of structuredData) {
    if (!isStructuredEvent(candidate)) {
      continue;
    }

    const startsAt = DateTime.fromISO(candidate.startDate, { setZone: true });

    if (!startsAt.isValid) {
      continue;
    }

    const posterValue = Array.isArray(candidate.image)
      ? candidate.image[0]
      : candidate.image;

    return {
      startsAt: startsAt.toJSDate(),
      posterURL:
        typeof posterValue === "string"
          ? resolveURL(posterValue, CONTEMPORARY_CALGARY_SOURCE_URL)
          : null
    };
  }

  return null;
}

function extractContemporaryCalgaryPurchaseURL($: cheerio.CheerioAPI): string | null {
  const ticketLinks = $("a[href]")
    .toArray()
    .filter((link) => normalizeWhitespace($(link).text()).toLowerCase() === "get tickets");

  for (const link of ticketLinks) {
    const resolvedHref = resolveURL($(link).attr("href") ?? "", CONTEMPORARY_CALGARY_SOURCE_URL);

    if (resolvedHref && !isInternalURL(resolvedHref, CONTEMPORARY_CALGARY_SOURCE_URL)) {
      return resolvedHref;
    }
  }

  return null;
}

function extractContemporaryCalgarySummary($: cheerio.CheerioAPI): string | null {
  const paragraphs = $(".eventitem-column-content .sqs-html-content p")
    .toArray()
    .map((element) => normalizeWhitespace($(element).text()))
    .filter(Boolean);

  const synopsis = paragraphs.find((paragraph) => {
    const lowercased = paragraph.toLowerCase();

    return (
      paragraph.length >= 80 &&
      !lowercased.startsWith("country:") &&
      !lowercased.includes("minutes, in") &&
      !lowercased.includes("free for members")
    );
  });

  return synopsis ?? nilIfBlank(paragraphs[0] ?? "");
}

function isStructuredEvent(
  value: unknown
): value is { "@type": string | string[]; startDate: string; image?: string | string[] } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    "@type"?: unknown;
    startDate?: unknown;
    image?: unknown;
  };
  const types = Array.isArray(candidate["@type"])
    ? candidate["@type"]
    : [candidate["@type"]];

  return (
    types.some((type) => type === "Event") &&
    typeof candidate.startDate === "string" &&
    (candidate.image === undefined ||
      typeof candidate.image === "string" ||
      (Array.isArray(candidate.image) &&
        candidate.image.every((image) => typeof image === "string")))
  );
}

function parseInferredDate(
  dateText: string,
  dateFormat: string,
  timeText: string,
  timeFormat: string,
  referenceDate: Date
): Date | null {
  const reference = DateTime.fromJSDate(referenceDate, { zone: SHOWTIME_TIME_ZONE });
  const candidateYears = [reference.year, reference.year + 1, reference.year - 1];

  for (const year of candidateYears) {
    const candidate = DateTime.fromFormat(
      `${dateText} ${year} ${timeText}`,
      `${dateFormat} yyyy ${timeFormat}`,
      {
        zone: SHOWTIME_TIME_ZONE,
        locale: "en-US"
      }
    );

    if (!candidate.isValid) {
      continue;
    }

    const diffDays = Math.abs(candidate.diff(reference, "days").days);

    if (diffDays <= 180) {
      return candidate.toJSDate();
    }
  }

  return null;
}

function buildShowtime(startsAt: Date, ticketURL: string | null): Showtime {
  return {
    id: `${Math.floor(startsAt.getTime() / 1000)}::${ticketURL ?? "none"}`,
    startsAt: startsAt.toISOString(),
    ticketURL
  };
}

function uniqueSortedShowtimes(showtimes: Showtime[]): Showtime[] {
  const unique = new Map<string, Showtime>();

  for (const showtime of showtimes) {
    if (!unique.has(showtime.id)) {
      unique.set(showtime.id, showtime);
    }
  }

  return Array.from(unique.values()).sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt)
  );
}

function sortListings(listings: Listing[]): Listing[] {
  return [...listings].sort((left, right) => {
    const leftDate = left.showtimes[0]?.startsAt ?? "";
    const rightDate = right.showtimes[0]?.startsAt ?? "";

    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }

    if (left.theatre !== right.theatre) {
      return left.theatre.localeCompare(right.theatre);
    }

    return left.title.localeCompare(right.title);
  });
}

function extractAction(
  entryContent: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI
): { label: string; url: string | null } | null {
  const links = entryContent.find("a[href]").toArray();

  for (const link of links) {
    const label = normalizeWhitespace($(link).text());
    const uppercased = label.toUpperCase();

    if (
      uppercased.includes("BUY TICKETS") ||
      uppercased.includes("FULL SCHEDULE AND TICKETS") ||
      uppercased.includes("FREE SCREENING")
    ) {
      return {
        label,
        url: resolveURL($(link).attr("href") ?? "", GLOBE_SOURCE_URL)
      };
    }
  }

  return null;
}

function cleanSummary(rawText: string): string | null {
  const normalized = normalizeWhitespace(rawText);

  if (!normalized) {
    return null;
  }

  const beforeArrival = normalized.split("~ READ BEFORE ARRIVING")[0] ?? normalized;
  const cleaned = normalizeWhitespace(
    beforeArrival
      .replace("Synopsis:", "")
      .replace("BUY TICKETS", "")
      .replace("FULL SCHEDULE AND TICKETS", "")
      .replace("FREE SCREENING", "")
  );

  return nilIfBlank(cleaned);
}

function inferKind(
  title: string,
  summary: string | null,
  actionLabel: string | null,
  showtimes: Showtime[]
): ListingKind {
  const lowercasedTitle = title.toLowerCase();
  const lowercasedSummary = summary?.toLowerCase() ?? "";
  const startOfDays = new Set(
    showtimes.map((showtime) =>
      DateTime.fromISO(showtime.startsAt, { zone: SHOWTIME_TIME_ZONE })
        .startOf("day")
        .toISODate()
    )
  );
  const uniqueDays = startOfDays.size;
  const uppercasedActionLabel = actionLabel?.toUpperCase() ?? "";

  if (uppercasedActionLabel.includes("FULL SCHEDULE AND TICKETS")) {
    return "event";
  }

  if (lowercasedTitle.includes("festival") && uniqueDays >= 2) {
    return "event";
  }

  if (
    lowercasedSummary.includes("takes over globe cinema") ||
    lowercasedSummary.includes("films presented:")
  ) {
    return "event";
  }

  return "movie";
}

function extractMetadataValue(label: string, summary: string): string | null {
  const labelIndex = summary.indexOf(label);

  if (labelIndex === -1) {
    return null;
  }

  const remainder = summary.slice(labelIndex + label.length);
  const stopLabels = ["Genre:", "Director:", "Stars:", "Running time:", "Rating:"].filter(
    (candidate) => candidate !== label
  );
  const nextLabelIndex = stopLabels
    .map((candidate) => remainder.indexOf(candidate))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  const value =
    nextLabelIndex === undefined
      ? remainder
      : remainder.slice(0, nextLabelIndex);

  return nilIfBlank(normalizeWhitespace(value));
}

function normalizedListingID(theatre: Theatre, title: string): string {
  return `${theatre}-${slugify(title)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveURL(value: string, baseURL: string): string | null {
  if (!value) {
    return null;
  }

  return new URL(value, baseURL).toString();
}

function isInternalURL(value: string, baseURL: string): boolean {
  return new URL(value).origin === new URL(baseURL).origin;
}

function nilIfBlank(value: string): string | null {
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeWhitespace(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").trim();
}
