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
  | "cancel_request"
  | "start_new_request"
  | "pick_option"
  | "find_booking";

// null = no active request.
export function toolsFor(state: State | null): Tool[] {
  const t = ((): Tool[] => {
    switch (state) {
      // Two widenings of the design table so Luna can do a whole message in one step:
      // set_slots with start_new_request (it applies to the request just started), and
      // the place tools while collecting. Code checks every call either way.
      case null:
        return ["start_new_request", "set_slots", "find_business", "my_places", "find_booking"];
      case "collecting":
        return [
          "set_slots",
          "find_business",
          "choose_business",
          "my_places",
          "find_booking",
          "cancel_request",
          "start_new_request",
        ];
      case "choosing_place":
        // Two additions to the design table: choose_business records the user's pick
        // from find_business results (the read-back names the place, so the YES covers
        // it), and set_slots takes a correction made while picking ("make it 8").
        return [
          "find_business",
          "choose_business",
          "set_slots",
          "my_places",
          "cancel_request",
          "start_new_request",
        ];
      case "confirming":
      case "awaiting_yes":
        return ["set_slots", "cancel_request", "start_new_request"];
      case "options_ready":
      case "awaiting_pick":
      case "stale_options":
        return ["pick_option", "set_slots", "cancel_request", "start_new_request"];
      // A queued request collects slots but gets no read-back until it activates.
      case "queued":
        return ["set_slots", "cancel_request", "start_new_request"];
      // In flight: Luna can only say what is happening. A new request is queued
      // by start_new_request, which the in-flight request ignores.
      case "calling_1":
      case "calling_2":
      case "verifying":
        return ["start_new_request"];
      default:
        return ["start_new_request", "my_places", "find_booking"];
    }
  })();
  return ["reply", ...t];
}
