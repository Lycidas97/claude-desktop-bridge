import { describe, expect, it, vi } from "vitest";
import { agendaCalendarDate, agendaInputTime, agendaInstant, agendaTimedRange, rereadAgendaPages } from "./assistant-agenda.js";

describe("agenda page refresh", () => {
  it("refreshes the loaded depth using the new cursor chain and drops missing records", async () => {
    const read = vi.fn(async (cursor?: string) => cursor === "new-next"
      ? { records: ["updated"], nextCursor: "older" }
      : { records: ["new"], nextCursor: "new-next" });

    await expect(rereadAgendaPages(read, 2)).resolves.toEqual({ records: ["new", "updated"], pages: 2, nextCursor: "older" });
    expect(read.mock.calls).toEqual([[undefined], ["new-next"]]);
  });

  it("retains incomplete coverage across a refreshed page chain", async () => {
    const read = vi.fn(async (cursor?: string) => cursor
      ? { records: ["older"] }
      : { records: ["first"], nextCursor: "next", incomplete: true as const });
    await expect(rereadAgendaPages(read, 2)).resolves.toMatchObject({ records: ["first", "older"], pages: 2, incomplete: true });
  });

  it("stops once the host runs out of pages and reads one page on first load", async () => {
    const read = vi.fn(async () => ({ records: ["remaining"] }));
    await expect(rereadAgendaPages(read, 4)).resolves.toMatchObject({ records: ["remaining"], pages: 1 });
    await expect(rereadAgendaPages(read, 0)).resolves.toMatchObject({ records: ["remaining"], pages: 1 });
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("calendar event times", () => {
  it("displays an embedded CalDAV TZID using the device time zone when Intl rejects it", () => {
    expect(agendaTimedRange("2026-01-15T14:00:00Z", "2026-01-15T15:00:00Z", "Eastern Standard Time", "America/Los_Angeles"))
      .toBe("2026-01-15 06:00 至 2026-01-15 07:00 (America/Los_Angeles)");
  });

  it("displays a recognized event zone with its zone label", () => {
    expect(agendaTimedRange("2026-06-30T15:15:00Z", "2026-06-30T16:15:00Z", "Asia/Tokyo", "America/Los_Angeles"))
      .toBe("2026-07-01 00:15 至 2026-07-01 01:15 (Asia/Tokyo)");
  });

  it("opens the device month after saving a timed event and preserves the month of an all-day date", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      const midnightInTokyo = agendaInstant("2026-07-01T00:15", "Asia/Tokyo");
      expect(agendaCalendarDate(midnightInTokyo, false).getMonth()).toBe(5);
      expect(agendaCalendarDate("2026-07-01T00:15:00Z", false).getMonth()).toBe(5);
      expect(agendaCalendarDate("2026-07-01", true).getMonth()).toBe(6);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("agenda form times", () => {
  it("leaves date-only values unchanged in zones on either side of UTC", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Shanghai"]) {
      expect(agendaInputTime("2026-11-18", zone)).toBe("2026-11-18");
      expect(agendaInstant("2026-11-19", zone)).toBe("2026-11-19");
    }
  });

  it("round trips a timed event in its selected zone across a UTC day boundary", () => {
    expect(agendaInstant("2026-11-18T00:15", "Asia/Kathmandu")).toBe("2026-11-17T18:30:00.000Z");
    expect(agendaInputTime("2026-11-17T18:30:00.000Z", "Asia/Kathmandu")).toBe("2026-11-18T00:15");
  });

  it("preserves an existing repeated-hour instant and rejects a skipped wall time", () => {
    const zone = "America/New_York";
    expect(agendaInstant("2026-11-01T01:30", zone)).toBe("2026-11-01T05:30:00.000Z");
    expect(agendaInstant("2026-11-01T01:30", zone, "2026-11-01T06:30:45.000Z")).toBe("2026-11-01T06:30:45.000Z");
    expect(() => agendaInstant("2026-03-08T02:30", zone)).toThrow("此时区没有这个时间");
  });
});
