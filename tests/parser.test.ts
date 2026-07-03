import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GLOBE_SOURCE_URL,
  GRAND_SOURCE_URL,
  PLAZA_SOURCE_URL,
  parseGlobeDate,
  parseGlobeHTML,
  parseGrandDate,
  parseGrandHTML,
  parsePlazaDate,
  parsePlazaHTML,
  refreshListings
} from "../scripts/support";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, "fixtures");
const referenceDate = new Date("2026-04-16T12:00:00.000Z");

const plazaHTML = readFileSync(path.join(fixtureDir, "plaza.html"), "utf8");
const globeHTML = readFileSync(path.join(fixtureDir, "globe.html"), "utf8");
const globeMinimalHTML = readFileSync(
  path.join(fixtureDir, "globe-minimal.html"),
  "utf8"
);
const grandHTML = readFileSync(path.join(fixtureDir, "grand.html"), "utf8");
const grandMovieHTML = readFileSync(
  path.join(fixtureDir, "grand-movie.html"),
  "utf8"
);
const grandEventHTML = readFileSync(
  path.join(fixtureDir, "grand-event.html"),
  "utf8"
);

describe("listing parsers", () => {
  it("combines Plaza date and film sections without duplicates", () => {
    const listings = parsePlazaHTML(plazaHTML, referenceDate);

    expect(listings).toHaveLength(1);
    expect(listings[0]?.title).toBe("Holy Days");
    expect(listings[0]?.showtimes).toHaveLength(2);
    expect(listings[0]?.summary).toBe("A road trip across New Zealand.");
    expect(listings[0]?.posterURL).toBe(
      "https://ticketing.uswest.veezi.com/Media/Poster?code=123"
    );
    expect(listings[0]?.showtimes[0]?.ticketURL).toBe(
      "https://ticketing.uswest.veezi.com/purchase/1?siteToken=test"
    );
  });

  it("separates Globe events from movies", () => {
    const listings = parseGlobeHTML(globeHTML, referenceDate);

    expect(listings).toHaveLength(2);

    const eventListing = listings.find((listing) => listing.title.includes("Festival"));
    const movieListing = listings.find(
      (listing) => listing.title === "Gambling, Gods and LSD"
    );

    expect(eventListing?.kind).toBe("event");
    expect(eventListing?.showtimes).toHaveLength(3);
    expect(movieListing?.kind).toBe("movie");
    expect(movieListing?.rating).toBe("14A");
    expect(movieListing?.purchaseURL).toBe(
      "https://calgarycinema.org/tickets/gambling"
    );
  });

  it("allows missing optional Globe fields", () => {
    const listings = parseGlobeHTML(globeMinimalHTML, referenceDate);

    expect(listings).toHaveLength(1);
    expect(listings[0]?.posterURL).toBeNull();
    expect(listings[0]?.purchaseURL).toBeNull();
    expect(listings[0]?.rating).toBeNull();
    expect(listings[0]?.showtimes).toHaveLength(1);
  });

  it("keeps only Grand detail pages with movie-specific signals", async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);

      if (url === "https://www.thegrandyyc.ca/sinners-attg") {
        return new Response(grandMovieHTML, { status: 200 });
      }

      if (url === "https://www.thegrandyyc.ca/songsinthesaddle") {
        return new Response(grandEventHTML, { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const listings = await parseGrandHTML(grandHTML, fetchStub, referenceDate);

    expect(listings).toHaveLength(1);
    expect(listings[0]?.title).toBe("SINNERS");
    expect(listings[0]?.kind).toBe("movie");
    expect(listings[0]?.theatre).toBe("grand");
    expect(listings[0]?.rating).toBe("14A");
    expect(listings[0]?.posterURL).toBe("https://example.com/sinners.png");
    expect(listings[0]?.purchaseURL).toBe("https://www.showpass.com/sinners-attg/");
    expect(listings[0]?.sourceURL).toBe("https://www.thegrandyyc.ca/sinners-attg");
    expect(listings[0]?.showtimes[0]?.startsAt).toBe("2026-07-11T02:00:00.000Z");
  });

  it("parses Plaza, Globe, and Grand dates in the Edmonton timezone", () => {
    expect(parsePlazaDate("Thursday 16, April", "2:00 PM", referenceDate)?.toISOString()).toBe(
      "2026-04-16T20:00:00.000Z"
    );
    expect(parseGlobeDate("April 30 - 6:30pm", referenceDate)?.toISOString()).toBe(
      "2026-05-01T00:30:00.000Z"
    );
    expect(parseGrandDate("JUL 10, 2026", "8:00PM", referenceDate)?.toISOString()).toBe(
      "2026-07-11T02:00:00.000Z"
    );
  });

  it("returns partial results when one provider fails", async () => {
    const fetchStub: typeof fetch = async (input) => {
      const url = String(input);

      if (url === PLAZA_SOURCE_URL) {
        return new Response(plazaHTML, { status: 200 });
      }

      if (url === GLOBE_SOURCE_URL) {
        throw new Error("Temporary outage");
      }

      if (url === GRAND_SOURCE_URL) {
        return new Response("<div></div>", { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const payload = await refreshListings(fetchStub, referenceDate);

    expect(payload.listings).toHaveLength(1);
    expect(payload.listings[0]?.title).toBe("Holy Days");
    expect(payload.warnings).toEqual([
      {
        sourceName: "Globe Cinema",
        message: "Temporary outage"
      }
    ]);
  });
});
