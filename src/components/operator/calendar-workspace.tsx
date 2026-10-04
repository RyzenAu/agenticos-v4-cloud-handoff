import { AccountConnections, useAccounts } from "./account-connections";
import "./calendar-fixes.css";
import "./calendar-readable.css";
import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { CalendarDemo, CALENDAR_DEMO_KEY } from "./calendar-demo";
import {
  BookmarkPlus,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  CalendarRange,
  Clock3,
  MapPin,
  RefreshCw,
  Plus,
  MessageSquare,
  ArrowUpRight,
  Link2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type CalendarEvent,
  localDay,
  operatorRequest,
  useOperator,
  askOperator,
} from "@/lib/operator";
import { Busy, Modal } from "./ui";
import { Disclosure, PageFoot, PageSkeleton } from "@/components/ds";
import { ChatPageComposer } from "./chat-page-composer";
import { NativeCalendarConnection, useNativeCalendar } from "./native-calendar-connection";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Segmented,
  Surface,
} from "@/components/ds";
import { fmtDay, fmtMonthYear, fmtTime } from "@/lib/format";
const clock = (value: string) =>
  fmtTime(new Date(value));
const providerName: Record<CalendarEvent["source"], string> = {
  google: "Google Calendar",
  outlook: "Outlook Calendar",
  cal: "Cal.com",
  ics: "Imported calendar",
  local: "Local event",
};
const eventOrder = (a: CalendarEvent, b: CalendarEvent) =>
  Date.parse(a.start) - Date.parse(b.start);
export function eventOnDay(event: CalendarEvent, day: string) {
  if (!day) return false;
  if (event.allDay) return event.start.slice(0, 10) <= day && event.end.slice(0, 10) > day;
  const start = new Date(`${day}T00:00:00`),
    end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (Date.parse(event.start) === Date.parse(event.end))
    return new Date(event.start) >= start && new Date(event.start) < end;
  return new Date(event.start) < end && new Date(event.end) > start;
}
export function CalendarWorkspace() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    const requested = new URLSearchParams(search).get("demo") === "1";
    let enabled = requested;
    try {
      enabled ||= localStorage.getItem(CALENDAR_DEMO_KEY) === "true";
      if (requested) localStorage.setItem(CALENDAR_DEMO_KEY, "true");
    } catch { /* The URL still enables the private demo when storage is unavailable. */ }
    setDemo(enabled);
  }, [search]);
  // Resolve privacy mode before mounting anything that reads the real calendar.
  if (demo === null) return <div className="op-page"><PageSkeleton rows={3} label="Loading calendar" /></div>;
  return demo ? <CalendarDemo onExit={() => {
    try { localStorage.removeItem(CALENDAR_DEMO_KEY); } catch { /* No persisted setting. */ }
    window.location.assign("/calendar");
  }} /> : <LiveCalendarWorkspace />;
}
function LiveCalendarWorkspace() {
  const { state, refresh, error } = useOperator();
  const { data: accounts, refetch: refreshAccounts, error: accountError } = useAccounts();
  const nativeCalendar = useNativeCalendar();
  const [view, setView] = useState("calendar");
  // R11: the agenda (a list of what is on, in order) is the default; the month grid is one click away.
  const [layout, setLayout] = useState("agenda");
  const [agendaRange, setAgendaRange] = useState("upcoming");
  const [syncing, setSyncing] = useState(false);
  const [month, setMonth] = useState<Date | null>(null),
    [day, setDay] = useState(""),
    [today, setToday] = useState(""),
    [add, setAdd] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [title, setTitle] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [location, setLocation] = useState(""),
    [attendees, setAttendees] = useState(""),
    [notes, setNotes] = useState(""),
    [actions, setActions] = useState<CalendarEvent["actions"]>([]),
    [actionText, setActionText] = useState(""),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [notice, setNotice] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const now = new Date();
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setDay(localDay(now));
    setToday(localDay(now));
  }, []);
  const event = state.events.find((e) => e.id === selected),
    dayEvents = state.events.filter((e) => eventOnDay(e, day)).sort(eventOrder);
  const calendarAccounts =
    accounts?.accounts.filter((a) => a.connected && ["google", "outlook", "cal"].includes(a.id)) ||
    [];
  const connected = calendarAccounts.filter((a) => a.calendarAccess === "granted");
  const syncable = calendarAccounts.filter((a) => a.calendarAccess !== "missing");
  const missingAccess = calendarAccounts.some((a) => a.calendarAccess === "missing");
  const upcoming = state.events
    .filter((e) => new Date(e.end) > new Date(`${today}T00:00:00`))
    .sort(eventOrder);
  const agendaEvents = agendaRange === "all" ? [...state.events].sort(eventOrder) : upcoming;
  const chatCandidates = [
    ...new Map(
      [
        ...dayEvents,
        ...upcoming.filter((event) => Date.parse(event.start) < Date.now() + 7 * 86400000),
      ].map((event) => [event.id, event]),
    ).values(),
  ].sort(eventOrder);
  const chatEvents = chatCandidates.slice(0, 100);
  function jumpToEvent(e: CalendarEvent) {
    const date = new Date(e.allDay ? e.start.slice(0, 10) + "T12:00:00" : e.start);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setDay(localDay(date));
  }
  async function syncCalendars() {
    setSyncing(true);
    setFailure("");
    setNotice("");
    try {
      const anchor = month || new Date();
      const timeMin = new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1).toISOString();
      const timeMax = new Date(anchor.getFullYear(), anchor.getMonth() + 13, 1).toISOString();
      const results = await Promise.allSettled(
        syncable.map((a) =>
          operatorRequest<{ events: number }>("/connections/sync", {
            provider: a.id,
            calendarOnly: true,
            timeMin,
            timeMax,
          }),
        ),
      );
      const failed = results.flatMap((r, index) =>
        r.status === "rejected"
          ? [
              `${syncable[index].id === "google" ? "Google" : syncable[index].id === "outlook" ? "Outlook" : "Cal.com"}: ${r.reason?.message || "Sync failed."}`,
            ]
          : [],
      );
      const count = results.reduce(
        (n, r) => n + (r.status === "fulfilled" ? r.value.events : 0),
        0,
      );
      await Promise.all([refresh(), refreshAccounts()]);
      if (failed.length) setFailure(failed.join(" "));
      if (results.some((r) => r.status === "fulfilled"))
        setNotice(
          `${count} calendar event${count === 1 ? "" : "s"} synced. Your saved notes are kept.`,
        );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  const cells: Date[] = [];
  if (month) {
    const first = new Date(month);
    first.setDate(1 - ((first.getDay() + 6) % 7));
    const rows = Math.ceil(
      (((month.getDay() + 6) % 7) +
        new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) /
        7,
    );
    for (let n = 0; n < rows * 7; n++) {
      const d = new Date(first);
      d.setDate(first.getDate() + n);
      cells.push(d);
    }
  }
  function newEvent() {
    setTitle("");
    setStart(`${day}T09:00`);
    setEnd(`${day}T10:00`);
    setLocation("");
    setAttendees("");
    setFailure("");
    setAdd(true);
  }
  function openEvent(e: CalendarEvent) {
    setSelected(e.id);
    setNotes(e.notes);
    setActions(e.actions);
    setActionText("");
    setFailure("");
  }
  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setFailure("");
    try {
      if (file.size > 1000000) throw new Error("Choose an .ics file under 1 MB.");
      const anchor = month || new Date();
      const r = await operatorRequest("/calendar/import", {
        ics: await file.text(),
        timeMin: new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1).toISOString(),
        timeMax: new Date(anchor.getFullYear(), anchor.getMonth() + 13, 1).toISOString(),
      });
      await refresh();
      setNotice(
        `${r.added} event${r.added === 1 ? "" : "s"} imported. ${r.message || "Duplicates were skipped."}`,
      );
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }
  async function saveNotes() {
    if (!event) return false;
    setBusy(true);
    try {
      await operatorRequest("/calendar", { id: event.id, notes, actions });
      await refresh();
      setNotice("Meeting notes and actions saved.");
      return true;
    } catch (e) {
      setFailure((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // The page's one headline and the four widgets under it come from the saved events.
  const todayEvents = today ? state.events.filter((e) => eventOnDay(e, today)).sort(eventOrder) : [];
  const nextToday = todayEvents.find((e) => !e.allDay && new Date(e.end).getTime() > Date.now());
  const weekCount = today
    ? upcoming.filter((e) => Date.parse(e.start) < Date.now() + 7 * 86400000).length
    : 0;
  const nextEvent = upcoming[0];
  // No calendar connected and nothing imported means "unknown", not "an empty day" (DESIGN-SYSTEM §5).
  const hasSource = connected.length > 0 || Boolean(nativeCalendar.data?.enabled) || state.events.length > 0;
  const headline = !today
    ? "Your schedule, booking links and availability."
    : !hasSource
      ? "No calendar yet. Connect one or import a file to see your day."
      : todayEvents.length
      ? `${todayEvents.length} ${todayEvents.length === 1 ? "event" : "events"} today${nextToday ? `, next at ${clock(nextToday.start)}` : ""}.`
      : nextEvent
        ? `Nothing on today. Next up: ${nextEvent.title}.`
        : "Nothing on today.";
  return (
    <div className="op-page l4-calendar">
      <PageHeader
        title="Calendar"
        description={headline}
        className="mb-6"
        actions={
          <>
            <AccountConnections
              calendarOnly
              label={
                connected.length || nativeCalendar.data?.enabled ? "Calendars" : "Connect calendar"
              }
            />
            <Button variant="accent" size="sm" onClick={newEvent}>
              <Plus size={14} />
              New event
            </Button>
          </>
        }
      />
      <div className="ar-calendar-toolbar">
        <Segmented
          ariaLabel="Calendar view"
          value={view}
          onChange={setView}
          options={[
            { value: "calendar", label: "Calendar" },
            { value: "links", label: "Booking links" },
            { value: "availability", label: "Availability" },
          ]}
        />
        <div className="ar-page-actions">
          <Button
            variant="link"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => upload.current?.click()}
            disabled={busy}
          >
            <Upload size={13} />
            Import .ics
          </Button>
          {view === "calendar" && (
            <Segmented
              ariaLabel="Calendar layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: "month", label: "Month" },
                { value: "agenda", label: "Agenda" },
              ]}
            />
          )}
        </div>
      </div>
      {view !== "calendar" && (
        <section className="mb-6" aria-label="Booking">
          {!accounts?.accounts.find((a) => a.id === "cal")?.connected ? (
            <EmptyState
              title={
                view === "links"
                  ? "Your booking links, right here."
                  : "Set the hours that work for you."
              }
              body={
                view === "links"
                  ? "Connect Cal.com to see your event types and open your booking pages."
                  : "Bring your Cal.com availability into view alongside your calendar."
              }
              action={
                <>
                  <AccountConnections only="cal" />
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={
                        view === "links"
                          ? "https://app.cal.com/event-types"
                          : "https://app.cal.com/availability"
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open Cal.com <ArrowUpRight size={13} />
                    </a>
                  </Button>
                </>
              }
            />
          ) : view === "links" ? (
            <div className="flex flex-col gap-3">
              {accounts.eventTypes.length ? (
                accounts.eventTypes.map((t: any) => (
                  <Surface key={t.id} className="flex items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-inset text-muted-foreground">
                      <Link2 size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-foreground">{t.title}</h3>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {t.lengthInMinutes || t.length} minutes ·{" "}
                        {t.description || "Cal.com booking link"}
                      </p>
                    </div>
                    {accounts.calUsername && t.slug && (
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`https://cal.com/${encodeURIComponent(accounts.calUsername)}/${encodeURIComponent(t.slug)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open link <ArrowUpRight size={13} />
                        </a>
                      </Button>
                    )}
                  </Surface>
                ))
              ) : (
                <EmptyState
                  title="No booking links synced yet."
                  body="Open Connections and sync Cal.com."
                />
              )}
              <Button variant="link" size="sm" className="self-start text-muted-foreground hover:text-foreground" asChild>
                <a href="https://app.cal.com/event-types" target="_blank" rel="noreferrer">
                  Manage booking links <ArrowUpRight size={13} />
                </a>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {accounts.schedules.length ? (
                accounts.schedules.map((s: any) => (
                  <Surface key={s.id} className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-inset text-muted-foreground">
                      <Clock3 size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-foreground">{s.name}</h3>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {s.timeZone}
                        {s.isDefault ? " · Default schedule" : ""}
                      </p>
                      {(s.availability || []).map((a: any, i: number) => (
                        <p key={i} className="mt-0.5 text-sm text-muted-foreground">
                          {(a.days || [])
                            .map((d: number | string) =>
                              typeof d === "number"
                                ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]
                                : d,
                            )
                            .join(", ")}{" "}
                          · {a.startTime?.slice(0, 5)}–{a.endTime?.slice(0, 5)}
                        </p>
                      ))}
                    </div>
                  </Surface>
                ))
              ) : (
                <EmptyState
                  title="No availability synced yet."
                  body="Open Connections and sync Cal.com."
                />
              )}
              <Button variant="link" size="sm" className="self-start text-muted-foreground hover:text-foreground" asChild>
                <a href="https://app.cal.com/availability" target="_blank" rel="noreferrer">
                  Edit availability in Cal.com <ArrowUpRight size={13} />
                </a>
              </Button>
            </div>
          )}
        </section>
      )}
      <input
        ref={upload}
        type="file"
        accept=".ics"
        hidden
        aria-label="Import ICS calendar"
        onChange={(e) => importFile(e.target.files?.[0])}
      />
      {(failure || error || accountError) && (
        <Notice tone="danger" className="mb-4">
          {failure || error?.message || accountError?.message}
        </Notice>
      )}
      {notice && (
        <Notice
          tone="success"
          className="mb-4"
          action={
            <Button variant="ghost" size="sm" onClick={() => setNotice("")}>
              Dismiss
            </Button>
          }
        >
          {notice}
        </Notice>
      )}
      {view === "calendar" && (
        <NativeCalendarConnection
          month={month}
          autoRefresh
          accountSync={
            syncable.length
              ? { count: syncable.length, busy: syncing, run: syncCalendars }
              : undefined
          }
          /* Import .ics is already in the toolbar below; the banner doesn't repeat it. */
        />
      )}
      {view === "calendar" && missingAccess && (
        <Notice tone="warn" className="mb-4">
          A connected account doesn't allow calendar access. Open Settings → Connections, reconnect
          it and allow calendar access — email access alone isn't enough.
        </Notice>
      )}
      {view === "calendar" && (connected.length > 0 || state.events.length > 0) && (
        <details className="ar-calendar-coverage">
          <summary>Calendar coverage · {state.events.length} saved events</summary>
          <div>
            {connected.map((account) => {
              const coverage = account.calendarCoverage;
              const outside =
                month &&
                coverage &&
                (new Date(month.getFullYear(), month.getMonth(), 1).getTime() <
                  Date.parse(coverage.timeMin) ||
                  new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime() >
                    Date.parse(coverage.timeMax));
              return (
                <p key={account.id}>
                  <strong>
                    {account.id === "google"
                      ? "Google"
                      : account.id === "outlook"
                        ? "Outlook"
                        : "Cal.com"}
                  </strong>
                  {coverage ? (
                    <>
                      {" "}
                      · {coverage.calendarCount} readable calendars · {coverage.eventCount} events ·{" "}
                      {fmtDay(new Date(coverage.timeMin), { year: true })}–
                      {fmtDay(new Date(coverage.timeMax), { year: true })}
                      <span>{coverage.calendars.map((calendar) => calendar.name).join(" · ")}</span>
                      {outside && (
                        <span className="ar-calendar-range-warning">
                          This month is outside the saved range. Sync this view to load it.
                        </span>
                      )}
                    </>
                  ) : (
                    <span>
                      Coverage has not been verified. Sync now to load all readable calendars.
                    </span>
                  )}
                </p>
              );
            })}
            {state.events.some((event) => event.source === "ics") && (
              <p>
                <strong>Imported .ics</strong> ·{" "}
                {state.events.filter((event) => event.source === "ics").length} events
                <span>
                  Saved snapshot. Recurring series expand within the imported date window; re-import
                  to refresh.
                </span>
              </p>
            )}
            {!connected.length && !nativeCalendar.data?.enabled && (
              <p>These events are saved locally; no live provider connection is active.</p>
            )}
          </div>
        </details>
      )}
      {view === "calendar" && (
        <div
          className={`op-calendar-layout ar-calendar-layout ${layout === "agenda" ? "is-agenda" : ""}`}
        >
          <div>
            {layout === "agenda" ? (
              <section className="ar-upcoming-agenda">
                <header className="ar-agenda-heading">
                  <h2>{agendaRange === "all" ? "All events" : "Upcoming"}</h2>
                  <Segmented
                    ariaLabel="Agenda date range"
                    value={agendaRange}
                    onChange={setAgendaRange}
                    options={[
                      { value: "upcoming", label: "Upcoming" },
                      { value: "all", label: "All saved events" },
                    ]}
                  />
                </header>
                {agendaEvents.map((e) => (
                  <button key={e.id} onClick={() => openEvent(e)}>
                    <time>
                      {fmtDay(new Date(
                        e.allDay ? e.start.slice(0, 10) + "T12:00:00" : e.start,
                      ))}
                    </time>
                    <div>
                      <strong>{e.title}</strong>
                      <p>
                        {e.allDay ? "All day" : clock(e.start)} ·{" "}
                        {e.location || e.calendarName || providerName[e.source]}
                      </p>
                    </div>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
                {!agendaEvents.length && (
                  <EmptyState
                    title={agendaRange === "all" ? "No saved events" : "No upcoming events"}
                    body={
                      state.events.length
                        ? "Your saved events are in the past. Choose All saved events to see them."
                        : connected.length
                          ? "Sync your connected calendars to bring in your schedule."
                          : "Your calendars have not been connected yet."
                    }
                  />
                )}
              </section>
            ) : (
              <Surface as="section" className="op-calendar-panel" padding="none">
                <div className="op-calendar-toolbar">
                  <h2>
                    {(month ? fmtMonthYear(month, { longMonth: true }) : "") ||
                      "Your calendar"}
                  </h2>
                  <div>
                    {upcoming[0] && (
                      <Button variant="ghost" size="sm" onClick={() => jumpToEvent(upcoming[0])}>
                        Next event
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const d = new Date();
                        setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                        setDay(localDay(d));
                      }}
                    >
                      Today
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous month"
                      onClick={() =>
                        month && setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
                      }
                    >
                      <ChevronLeft size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next month"
                      onClick={() =>
                        month && setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
                      }
                    >
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                </div>
                <div className="op-weekdays">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="op-month-grid">
                  {cells.map((d) => {
                    const key = localDay(d),
                      events = state.events.filter((e) => eventOnDay(e, key)).sort(eventOrder);
                    return (
                      <button
                        key={key}
                        className={`op-calendar-day ${key === day ? "selected" : ""} ${key === today ? "today" : ""} ${d.getMonth() !== month?.getMonth() ? "outside" : ""}`}
                        onClick={() => setDay(key)}
                        aria-label={`${fmtDay(d, { year: true, longMonth: true })}, ${events.length} events`}
                        aria-pressed={key === day}
                      >
                        <span>{d.getDate()}</span>
                        {events.slice(0, 2).map((e) => (
                          <div key={e.id} className="op-calendar-event">
                            {e.allDay ? "" : clock(e.start) + " "}
                            {e.title}
                          </div>
                        ))}
                        {events.length > 2 && (
                          <div className="op-calendar-event more">+{events.length - 2} more</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </Surface>
            )}
          </div>
          <div className="op-calendar-aside">
            <Surface as="section" padding="none">
              <div className="op-panel-title">
                <div>
                  <h2>
                    {day
                      ? fmtDay(new Date(`${day}T12:00`), { weekday: "long" })
                      : "Your day"}
                  </h2>
                  <small>
                    {dayEvents.length} scheduled {dayEvents.length === 1 ? "event" : "events"}
                  </small>
                </div>
                <CalendarDays size={17} className="op-muted" />
              </div>
              {dayEvents.length ? (
                dayEvents.map((e) => (
                  <button key={e.id} className="op-agenda-item" onClick={() => openEvent(e)}>
                    <span className="op-agenda-time">{e.allDay ? "All day" : clock(e.start)}</span>
                    <div>
                      <h3>{e.title}</h3>
                      <p>{e.location || e.calendarName || "Open notes & action items"}</p>
                      {e.actions.length > 0 && (
                        <span className="op-pill">
                          {e.actions.filter((a) => a.done).length}/{e.actions.length} actions done
                        </span>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <EmptyState
                  icon={CalendarDays}
                  title="No events this day"
                  body={
                    state.events.length
                      ? "Choose another day to see its events."
                      : "Connect your calendar above to bring your schedule here."
                  }
                />
              )}
            </Surface>
          </div>
        </div>
      )}
      <Disclosure summary="Ask about your calendar" meta="Prepare for meetings, spot clashes" className="mb-6 mt-6">
      <ChatPageComposer
        contextSource="meetings"
        title="Ask about your calendar"
        description="Prepare for meetings, spot clashes or plan your day. Continue the conversation in Chat."
        suggestions={[
          "Prepare for my next meeting",
          "What does my week look like?",
          "Check for scheduling clashes",
        ]}
        placeholder="Help me prepare for my next meeting…"        context={`CALENDAR SNAPSHOT: ${JSON.stringify({ now: new Date().toISOString(), selectedDay: day, coverage: nativeCalendar.data?.coverage, connected: connected.length > 0 || !!nativeCalendar.data?.enabled, totalRelevantEvents: chatCandidates.length, truncated: chatCandidates.length > chatEvents.length, events: chatEvents.map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendar: e.calendarName, location: e.location, notes: e.notes.slice(0, 300), actions: e.actions.slice(0, 8) })) })}. Events cover the selected day and the next seven days, with a maximum of 100 items. This is saved context, not live availability. Missing events never prove a free slot; other calendars may not be included. Calendar changes require the separate event review and confirmation.`}
      />
      </Disclosure>
      <PageFoot>
        Times follow your browser’s timezone; all-day dates stay on their calendar day.{" "}
        {nativeCalendar.data?.enabled
          ? "Google Calendar refreshes your primary calendar every 15 minutes."
          : "Connected calendars refresh every 15 minutes."}{" "}
        Imported files are saved snapshots.
      </PageFoot>
      <Modal
        open={add}
        onClose={() => setAdd(false)}
        title="Make time for it."
        description="Add an event to your local calendar. No invitations are sent."
      >
        <form
          className="op-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setFailure("");
            try {
              await operatorRequest("/calendar", {
                title,
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString(),
                location,
                attendees,
              });
              await refresh();
              setAdd(false);
              setDay(localDay(new Date(start)));
              setMonth(new Date(new Date(start).getFullYear(), new Date(start).getMonth(), 1));
              setNotice("Event added to your calendar.");
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Event title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What’s on the agenda?"
              required
            />
          </label>
          <div className="op-form-row">
            <label>
              Starts
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Ends
              <input
                type="datetime-local"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            Location or meeting link
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Add a place or call link"
            />
          </label>
          <label>
            People
            <input
              value={attendees}
              onChange={(e) => setAttendees(e.target.value)}
              placeholder="Names for your reference"
            />
          </label>
          {failure && (
            <Notice tone="danger" role="alert">
              {failure}
            </Notice>
          )}
          <Button variant="accent" disabled={busy}>
            {busy ? <Busy /> : <Plus size={14} />} Add event
          </Button>
        </form>
      </Modal>
      <Modal
        open={!!event}
        onClose={() => setSelected(null)}
        title={event?.title || "Meeting"}
        description={
          event
            ? `${fmtDay(new Date(event.allDay ? event.start.slice(0, 10) + "T12:00:00" : event.start), { longMonth: true })} · ${event.allDay ? "All day" : `${clock(event.start)} – ${clock(event.end)}`} · ${event.calendarName || providerName[event.source]}`
            : ""
        }
      >
        {event && (
          <>
            <div className="op-detail-meta">
              {event.location && (
                <span>
                  <MapPin size={12} style={{ display: "inline", marginRight: 5 }} />
                  {event.location}
                </span>
              )}
              {event.attendees && <span>{event.attendees}</span>}
            </div>
            <form
              className="op-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveNotes();
              }}
            >
              <label>
                Meeting notes
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Agenda, decisions, or a transcript from your notetaker…"
                />
              </label>
              <div>
                <div className="mb-2 text-sm font-medium text-muted-foreground">Next steps</div>
                {actions.map((a) => (
                  <label key={a.id} className={`op-action-item ${a.done ? "done" : ""}`}>
                    <input
                      type="checkbox"
                      checked={a.done}
                      onChange={(e) =>
                        setActions((items) =>
                          items.map((x) => (x.id === a.id ? { ...x, done: e.target.checked } : x)),
                        )
                      }
                    />
                    <span style={{ flex: 1 }}>{a.text}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove action ${a.text}`}
                      onClick={() => setActions((items) => items.filter((x) => x.id !== a.id))}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </label>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <input
                    value={actionText}
                    onChange={(e) => setActionText(e.target.value)}
                    placeholder="Add an action item…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (actionText.trim()) {
                          setActions((a) => [
                            ...a,
                            { id: crypto.randomUUID(), text: actionText.trim(), done: false },
                          ]);
                          setActionText("");
                        }
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!actionText.trim()}
                    onClick={() => {
                      setActions((a) => [
                        ...a,
                        { id: crypto.randomUUID(), text: actionText.trim(), done: false },
                      ]);
                      setActionText("");
                    }}
                  >
                    <Plus size={14} />
                  </Button>
                </div>
              </div>
              {failure && (
                <Notice tone="danger" role="alert">
                  {failure}
                </Notice>
              )}
              <div className="op-detail-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    if (!notes.trim()) {
                      setFailure("Add your meeting notes before saving to Memory.");
                      return;
                    }
                    if (!(await saveNotes())) return;
                    try {
                      await operatorRequest("/memory", {
                        title: event.title,
                        text: `Meeting: ${event.title}\nDate: ${event.start}\n\n${notes}\n\nActions:\n${actions.map((a) => `${a.done ? "[done]" : "[open]"} ${a.text}`).join("\n")}`,
                        kind: "meeting",
                        collection: "business",
                      });
                      await refresh();
                      setNotice("Meeting notes saved to Business memory.");
                      setSelected(null);
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  <BookmarkPlus size={13} /> Save to memory
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={async () => {
                    try {
                      await operatorRequest("/calendar", { id: event.id, action: "delete" });
                      await refresh();
                      setSelected(null);
                      setNotice(
                        event.source === "local" || event.source === "ics"
                          ? "Event removed from this workspace."
                          : "Event removed from this workspace. It is unchanged in your connected calendar and will return on sync.",
                      );
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={13} /> Delete
                </Button>
                <Button variant="accent" disabled={busy}>
                  {busy ? <Busy /> : <Check size={13} />} Save notes
                </Button>
              </div>
            </form>
          </>
        )}
      </Modal>
    </div>
  );
}
