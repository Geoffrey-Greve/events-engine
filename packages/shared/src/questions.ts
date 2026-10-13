/**
 * Custom registration questions — the wire contract (Phase 2.3).
 *
 * A question is a definition owned by the tenant; an answer is a fact recorded against one
 * seat or one booking. Both sides of the CMS ↔ worker boundary import these, so the shape
 * the registration module renders and the shape the worker validates cannot drift.
 *
 * Answers travel keyed by the question's `key`, never by its id: the id is a database
 * detail, while the key is the stable slug a form template, a CSV column and a HubSpot
 * property mapping are all written against.
 */

export type QuestionFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'phone';

/**
 * 'attendee' — asked once per seat (dietary requirements, coffee order).
 * 'order'    — asked once per booking (purchase order number, invoice contact).
 *
 * A bulk booking is what makes the distinction real: four seats, four dietary answers,
 * one PO number.
 */
export type QuestionScope = 'attendee' | 'order';

/** One choice on a select/multiselect question. */
export interface QuestionOption {
  value: string;
  label: string;
}

/**
 * A question as the front end receives it. Deliberately excludes anything a public caller
 * has no business seeing — there is nothing here but the definition, and no answers.
 */
export interface RegistrationQuestion {
  id: string;
  key: string;
  label: string;
  fieldType: QuestionFieldType;
  /** Present for select/multiselect, null otherwise. */
  options: QuestionOption[] | null;
  required: boolean;
  scope: QuestionScope;
  helpText: string | null;
  sortOrder: number;
  /** Null for a tenant-wide default; set when this question is specific to one event. */
  eventId: string | null;
  /**
   * The HubSpot CONTACT property this question is about, when it is about the PERSON
   * rather than the event — an attendee's dietary requirements and coffee order do not
   * change between courses.
   *
   * The front end uses it to prefill the field from the known visitor's own contact, which
   * is how "you should not have to type this again" is delivered without the worker
   * handing anyone's stored answers to an unauthenticated caller. Null = the answer stays
   * inside the worker.
   */
  hsProperty: string | null;
  /**
   * Whether the stored value may be offered back as the default next time. Only meaningful
   * with `hsProperty` set; false for a question that maps to a property for reporting but
   * must be answered fresh each event.
   */
  prefill: boolean;
}

/**
 * Answers as they are sent, keyed by question `key`.
 *
 * `string[]` is a multiselect, `boolean` a checkbox, `string` everything else. `null` and
 * `''` both mean "not answered", which is a validation failure for a required question and
 * is otherwise stored as nothing at all rather than as an empty answer.
 */
export type QuestionAnswerValue = string | string[] | boolean | null;
export type QuestionAnswers = Record<string, QuestionAnswerValue>;

/** Response body of `GET /api/v1/events/:slug/questions`. */
export interface EventQuestionsResponse {
  eventId: string;
  /** Every question this event asks, tenant-wide defaults included, in display order. */
  questions: RegistrationQuestion[];
}
