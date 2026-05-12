export type Theatre = "plaza" | "globe";
export type ListingKind = "movie" | "event";

export type ProviderWarning = {
  sourceName: string;
  message: string;
};

export type Showtime = {
  id: string;
  startsAt: string;
  ticketURL: string | null;
};

export type Listing = {
  id: string;
  title: string;
  kind: ListingKind;
  theatre: Theatre;
  rating: string | null;
  summary: string | null;
  posterURL: string | null;
  purchaseURL: string | null;
  sourceURL: string;
  showtimes: Showtime[];
};

export type ListingsPayload = {
  generatedAt: string;
  timeZone: "America/Edmonton";
  listingCount: number;
  warnings: ProviderWarning[];
  listings: Listing[];
};

export type ListingRow = {
  id: string;
  listingId: string;
  title: string;
  kind: ListingKind;
  theatre: Theatre;
  rating: string | null;
  summary: string | null;
  posterURL: string | null;
  sourceURL: string;
  purchaseURL: string | null;
  dateKey: string;
  dateLabel: string;
  showtimes: Showtime[];
};
