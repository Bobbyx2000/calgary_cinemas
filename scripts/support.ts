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
    .map((partial) => {
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

function nilIfBlank(value: string): string | null {
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeWhitespace(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").trim();
}
