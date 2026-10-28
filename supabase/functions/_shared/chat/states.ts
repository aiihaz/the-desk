// Request states, their groups, and the tools Luna may use in each (E4 design 2.1, 2.5).
// The database (0004_chat.sql) enforces the transitions; this file only says what
// the chat agent offers in each state.

export type Task = "booking" | "question" | "reschedule" | "cancel";

export type State =
  | "collecting"
  | "choosing_place"
  | "confirming"
  | "awaiting_yes"
  | "calling_1"
  | "options_ready"
  | "awaiting_pick"
  | "calling_2"
  | "verifying"
  | "done"
  | "awaiting_payment"
  | "stale_options"
  | "cancelled"
  | "queued"
  | "expired";

export type Group = "before_consent" | "after_call_1" | "in_flight" | "queued" | "awaiting_payment" | "ended";

// Same as request_group() in SQL.
export function group(state: State): Group {
  switch (state) {
    case "collecting":
    case "choosing_place":
    case "confirming":
    case "awaiting_yes":
      return "before_consent";
    case "options_ready":
    case "awaiting_pick":
    case "stale_options":
      return "after_call_1";
    case "calling_1":
    case "calling_2":
    case "verifying":
      return "in_flight";
    case "queued":
      return "queued";
    case "awaiting_payment":
      return "awaiting_payment";
    default:
      return "ended";
  }
}

export type Tool =
  | "reply"
  | "set_slots"
  | "find_business"
  | "choose_business"
  | "my_places"
  | "propose_plan"
  | "approve_plan"
  | "cancel_request"
  | "start_new_request"
  | "pause_request"
  | "resume_request"
  | "find_booking";

// Reschedule and cancel need Desk bookings, which come with E6. Until then neither is
// offered, so Luna says so once instead of collecting details for a request that can't finish.
export const BOOKING_CHANGES = false;
export const TASKS: Task[] = BOOKING_CHANGES
  ? ["booking", "question", "reschedule", "cancel"]
  : ["booking", "question"];
const findBooking: Tool[] = BOOKING_CHANGES ? ["find_booking"] : [];

// null = no active request. paused: the request is on hold (pause_request). Errands
// waiting in the queue are edited with the same tools, named by their errand ref.
export function toolsFor(state: State | null, paused = false): Tool[] {
  const hold: Tool[] = [paused ? "resume_request" : "pause_request"];
  const errands: Tool[] = ["cancel_request", "start_new_request"];
  const place: Tool[] = ["find_business", "choose_business", "my_places"];
  const t = ((): Tool[] => {
    switch (state) {
      case null:
        return ["start_new_request", "set_slots", ...place, ...findBooking];
      // Before consent: collect, then propose the plan when nothing is missing and the
      // user has nothing open. Paused: no plan and no approval until they're back.
      case "collecting":
      case "choosing_place":
      case "confirming":
        return [
          "set_slots",
          ...place,
          ...findBooking,
          ...(paused ? [] : ["propose_plan" as Tool]),
          ...hold,
          ...errands,
        ];
      case "awaiting_yes":
        return ["approve_plan", "set_slots", ...place, "propose_plan", ...hold, ...errands];
      // After call 1: the user picks an option in words; approve_plan with its number.
      case "options_ready":
      case "awaiting_pick":
      case "stale_options":
        return ["approve_plan", "set_slots", ...errands];
      case "queued":
        return ["set_slots", ...place, ...errands];
      // In flight: the call can't change. Other errands can be queued and edited.
      case "calling_1":
      case "calling_2":
      case "verifying":
        return ["set_slots", ...place, ...errands];
      default:
        return ["start_new_request", "set_slots", ...place, ...findBooking];
    }
  })();
  return ["reply", ...t];
}
