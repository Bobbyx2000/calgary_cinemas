import type { Listing, ListingRow, Showtime, Theatre } from "./types";

const THEATRE_LABELS: Record<Theatre, string> = {
  globe: "Globe Cinema",
  plaza: "The Plaza Theatre"
};

export function theatreLabel(theatre: Theatre): string {
  return THEATRE_LABELS[theatre];
}

export function getDateKey(isoString: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(isoString));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatDateLabel(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(isoString));
}

export function formatSelectedDateLabel(dateKey: string, timeZone: string): string {
  if (!dateKey) {
    return "";
  }

  const [year, month, day] = dateKey.split("-").map((value) => Number(value));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return dateKey;
  }

  const weekday = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short"
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));

  return `${weekday}, ${dateKey}`;
}

export function formatTimeLabel(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

export function formatTimestamp(isoString: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(isoString));
}

export function truncate(value: string | null, maxLength = 140): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getAvailableDates(listings: Listing[], timeZone: string): string[] {
  const dateKeys = listings.flatMap((listing) =>
    listing.showtimes.map((showtime) => getDateKey(showtime.startsAt, timeZone))
  );

  return Array.from(new Set(dateKeys)).sort();
}

export function buildRows(listings: Listing[], timeZone: string): ListingRow[] {
  const rows = listings.flatMap((listing) => {
    const byDate = new Map<string, Showtime[]>();

    for (const showtime of listing.showtimes) {
      const dateKey = getDateKey(showtime.startsAt, timeZone);
      const existing = byDate.get(dateKey) ?? [];
      existing.push(showtime);
      byDate.set(dateKey, existing);
    }

    return Array.from(byDate.entries()).map(([dateKey, showtimes]) => {
      const sortedShowtimes = [...showtimes].sort((left, right) =>
        left.startsAt.localeCompare(right.startsAt)
      );

      return {
        id: `${listing.id}-${dateKey}`,
        listingId: listing.id,
        title: listing.title,
        kind: listing.kind,
        theatre: listing.theatre,
        rating: listing.rating,
        summary: truncate(listing.summary),
        posterURL: listing.posterURL,
        sourceURL: listing.sourceURL,
        purchaseURL:
          sortedShowtimes.find((showtime) => showtime.ticketURL)?.ticketURL ??
          listing.purchaseURL,
        dateKey,
        dateLabel: formatDateLabel(sortedShowtimes[0].startsAt, timeZone),
        showtimes: sortedShowtimes
      };
    });
  });

  return rows.sort((left, right) => {
    const leftStart = left.showtimes[0]?.startsAt ?? "";
    const rightStart = right.showtimes[0]?.startsAt ?? "";

    if (leftStart !== rightStart) {
      return leftStart.localeCompare(rightStart);
    }

    if (left.theatre !== right.theatre) {
      return left.theatre.localeCompare(right.theatre);
    }

    return left.title.localeCompare(right.title);
  });
}
