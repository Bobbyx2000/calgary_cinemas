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
      posterURL: null,
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

  it("selects the earliest available date by default", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Indie Showtimes" });

    const dateSelect = screen.getByLabelText("Date") as HTMLSelectElement;
    expect(dateSelect.value).toBe("2026-04-16");
    expect(screen.getAllByText("Holy Days")).toHaveLength(2);
  });

  it("renders provider warnings and listing links", async () => {
    mockFetch(payload);
    render(<App />);

    const banner = await screen.findByRole("status");

    expect(banner).toHaveTextContent("Globe Cinema: Temporary outage");
    expect(screen.getAllByRole("link", { name: "Tickets" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Source" }).length).toBeGreaterThan(0);
  });

  it("filters rows by theatre", async () => {
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Indie Showtimes" });

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
    mockFetch(payload);
    render(<App />);

    await screen.findByRole("heading", { name: "Calgary Indie Showtimes" });

    fireEvent.change(screen.getByLabelText("Theatre"), {
      target: { value: "globe" }
    });
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-04-21" }
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Nothing matches the current filters/i)
      ).toBeInTheDocument();
    });
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
