import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ListingsPayload } from "../src/lib/types";

const payload: ListingsPayload = {
  generatedAt: "2026-05-11T12:00:00.000Z",
  timeZone: "America/Edmonton",
  listingCount: 2,
  warnings: [
    {
      sourceName: "Globe Cinema",
      message: "Temporary outage"
    }
  ],
  listings: [
    {
      id: "plaza-holy-days",
      title: "Holy Days",
      kind: "movie",
      theatre: "plaza",
      rating: "PG",
      summary: "A road trip across New Zealand.",
      posterURL: "https://example.com/holy-days.jpg",
      purchaseURL: "https://ticketing.uswest.veezi.com/purchase/1?siteToken=test",
      sourceURL: "https://ticketing.uswest.veezi.com/sessions/?siteToken=abc",
      showtimes: [
        {
          id: "1",
          startsAt: "2026-04-16T20:00:00.000Z",
          ticketURL: "https://ticketing.uswest.veezi.com/purchase/1?siteToken=test"
        },
        {
          id: "2",
          startsAt: "2026-04-21T21:00:00.000Z",
          ticketURL: "https://ticketing.uswest.veezi.com/purchase/2?siteToken=test"
        }
      ]
    },
    {
      id: "globe-festival",
      title: "Calgary Underground Film Festival",
      kind: "event",
      theatre: "globe",
      rating: null,
      summary: "Festival week with screenings across multiple days.",
      posterURL: null,
      purchaseURL: "https://festival.example/schedule",
      sourceURL: "https://globecinema.ca/movie.html#1444",
      showtimes: [
        {
          id: "3",
          startsAt: "2026-04-17T01:00:00.000Z",
          ticketURL: "https://festival.example/schedule"
        }
      ]
    }
  ]
};

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders all dates by default without a date filter", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Showtimes" });

    expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
    expect(screen.getAllByText("Holy Days")).toHaveLength(2);
    expect(screen.getByText("Wed, Apr 16")).toBeInTheDocument();
    expect(screen.getByText("Tue, Apr 21")).toBeInTheDocument();
  });

  it("renders updated hero copy, provider warnings, and listing links", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Showtimes" });

    expect(
      screen.getByText("Live listings from The Plaza Theatre and Globe Cinema")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Static site. Fresh data. Zero server bill.")
    ).not.toBeInTheDocument();

    const banner = await screen.findByRole("status");

    expect(banner).toHaveTextContent("Globe Cinema: Temporary outage");
    expect(screen.getAllByRole("link", { name: "Tickets" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Source" }).length).toBeGreaterThan(0);
  });

  it("filters rows by theatre", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Showtimes" });

    fireEvent.change(screen.getByLabelText("Theatre"), {
      target: { value: "globe" }
    });

    expect(screen.getAllByText("Calgary Underground Film Festival")).toHaveLength(1);
    expect(screen.queryAllByText("Holy Days")).toHaveLength(0);
  });

  it("renders a no-data state when the payload is empty", async () => {
    mockFetch({
      ...payload,
      listingCount: 0,
      warnings: [],
      listings: []
    });

    render(<App />);

    await screen.findByText(/No listings are available right now/i);
  });

  it("renders a no-match state when filters exclude all rows", async () => {
    mockFetch({
      ...payload,
      listingCount: 1,
      listings: [payload.listings[0]]
    });
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Showtimes" });

    fireEvent.change(screen.getByLabelText("Theatre"), {
      target: { value: "globe" }
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Nothing matches the current filters/i)
      ).toBeInTheDocument();
    });
  });

  it("renders poster thumbnails when available and omits them otherwise", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Showtimes" });

    expect(screen.getAllByAltText("Holy Days poster").length).toBeGreaterThan(0);
    expect(
      screen.queryByAltText("Calgary Underground Film Festival poster")
    ).not.toBeInTheDocument();
  });
});

function mockFetch(mockPayload: ListingsPayload) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(mockPayload), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    })
  );
}
