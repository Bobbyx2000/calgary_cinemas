import { useEffect, useMemo, useState } from "react";
import {
  buildRows,
  formatSelectedDateLabel,
  formatTimeLabel,
  formatTimestamp,
  getAvailableDates,
  theatreLabel
} from "./lib/listings";
import type { ListingRow, ListingsPayload, Theatre } from "./lib/types";
import "./app.css";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; payload: ListingsPayload }
  | { status: "error"; message: string };

function App() {
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [selectedTheatre, setSelectedTheatre] = useState<"all" | Theatre>("all");
  const [selectedDate, setSelectedDate] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}listings.json`);

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as ListingsPayload;

        if (!cancelled) {
          setLoadState({ status: "loaded", payload });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState({
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error"
          });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const payload = loadState.status === "loaded" ? loadState.payload : null;
  const availableDates = useMemo(
    () => (payload ? getAvailableDates(payload.listings, payload.timeZone) : []),
    [payload]
  );

  useEffect(() => {
    if (!payload) {
      return;
    }

    setSelectedDate((currentDate) => {
      if (currentDate) {
        return currentDate;
      }

      return availableDates[0] ?? "";
    });
  }, [availableDates, payload]);

  const rows = useMemo(() => {
    if (!payload) {
      return [];
    }

    const allRows = buildRows(payload.listings, payload.timeZone);

    return allRows.filter((row) => {
      const theatreMatches =
        selectedTheatre === "all" ? true : row.theatre === selectedTheatre;
      const dateMatches = selectedDate ? row.dateKey === selectedDate : true;

      return theatreMatches && dateMatches;
    });
  }, [payload, selectedDate, selectedTheatre]);

  return (
    <main className="page-shell">
      <section className="hero">
        <h1>Calgary Showtimes</h1>
        <p className="lede">Live listings from The Plaza Theatre and Globe Cinema</p>

        {payload ? (
          <div className="meta-strip">
            <span>Updated {formatTimestamp(payload.generatedAt, payload.timeZone)}</span>
            <span>{payload.listingCount} listings</span>
            <span>{payload.timeZone}</span>
          </div>
        ) : null}
      </section>

      <section className="panel">
        {loadState.status === "loading" ? (
          <p className="state-message">Fetching the latest showtimes...</p>
        ) : null}

        {loadState.status === "error" ? (
          <p className="state-message">
            Couldn&apos;t load listings. {loadState.message}
          </p>
        ) : null}

        {payload ? (
          <>
            {payload.warnings.length > 0 ? (
              <div className="warning-banner" role="status">
                {payload.warnings.map((warning) => (
                  <p key={`${warning.sourceName}-${warning.message}`}>
                    <strong>{warning.sourceName}:</strong> {warning.message}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="filters" aria-label="Showtime filters">
              <label>
                <span>Theatre</span>
                <select
                  value={selectedTheatre}
                  onChange={(event) =>
                    setSelectedTheatre(event.target.value as "all" | Theatre)
                  }
                >
                  <option value="all">All theatres</option>
                  <option value="plaza">The Plaza Theatre</option>
                  <option value="globe">Globe Cinema</option>
                </select>
              </label>

              <label>
                <span>Date</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  disabled={availableDates.length === 0}
                />
                <span className="filter-helper">
                  {selectedDate
                    ? formatSelectedDateLabel(selectedDate, payload.timeZone)
                    : "No dates available"}
                </span>
              </label>
            </div>

            {payload.listings.length === 0 ? (
              <p className="state-message">
                No listings are available right now. Check back after the next
                scheduled refresh.
              </p>
            ) : rows.length === 0 ? (
              <p className="state-message">
                Nothing matches the current filters. Try another date or switch
                back to all theatres.
              </p>
            ) : (
              <ResultsTable rows={rows} timeZone={payload.timeZone} />
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}

function ListingTitleCell({ row }: { row: ListingRow }) {
  const [hidePoster, setHidePoster] = useState(false);

  return (
    <div className="title-cell">
      {row.posterURL && !hidePoster ? (
        <img
          src={row.posterURL}
          alt={`${row.title} poster`}
          className="poster-thumb"
          loading="lazy"
          onError={() => setHidePoster(true)}
        />
      ) : null}

      <div className="title-copy">
        <strong>{row.title}</strong>
        {row.summary ? <p>{row.summary}</p> : null}
      </div>
    </div>
  );
}

function ResultsTable({
  rows,
  timeZone
}: {
  rows: ListingRow[];
  timeZone: string;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Theatre</th>
            <th>Type</th>
            <th>Rating</th>
            <th>Date</th>
            <th>Showtimes</th>
            <th>Links</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <ListingTitleCell row={row} />
              </td>
              <td>{theatreLabel(row.theatre)}</td>
              <td>{row.kind === "event" ? "Event" : "Movie"}</td>
              <td>{row.rating ?? "Unrated"}</td>
              <td>{row.dateLabel}</td>
              <td>
                <div className="showtime-list">
                  {row.showtimes.map((showtime) => (
                    <span key={showtime.id}>
                      {formatTimeLabel(showtime.startsAt, timeZone)}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <div className="link-list">
                  {row.purchaseURL ? (
                    <a href={row.purchaseURL} target="_blank" rel="noreferrer">
                      Tickets
                    </a>
                  ) : null}
                  <a href={row.sourceURL} target="_blank" rel="noreferrer">
                    Source
                  </a>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
