/**
 * Custom registration questions and their answers (Phase 2.3).
 *
 * Dietary requirements is a CASE of this, not a feature of its own. Nothing in this module
 * names it: a tenant defines questions, an event may narrow or override them, and the
 * dietary field is one seeded row. The next thing Weld asks for is a row, not a release.
 *
 * ## Three ideas hold the module together
 *
 * 1. **Definitions resolve most-specific-first, by key.** A question with `event_id = NULL`
 *    is asked on every event; one naming an event replaces the tenant-wide row that shares
 *    its `key`. Same order `pricing_rules` resolves in, and for the same reason: the common
 *    case is one shared set, and the exception should cost one row rather than a per-event
 *    copy of everything.
 *
 * 2. **Validation is server-side, full stop.** The brief is explicit that the form must not
 *    be the only place `required` is enforced, and the reason is structural rather than
 *    defensive: the front end is a HubSpot CMS module a marketer can edit, and staff and
 *    corporate bookings never render it at all. `validateAnswers` is the one gate every
 *    booking path goes through.
 *
 * 3. **A mapped question round-trips through the attendee's contact.** An attendee's
 *    dietary requirements and coffee order are facts about the PERSON — the same in March
 *    as in October — so a question may name the HubSpot contact property it is really
 *    about. The answer is written back there (`contact.sync_answers`), and `prefill` says
 *    it may be offered as the default next time. That is the whole "you should not have to
 *    type this again" mechanism, and it is why `hs_property` is not merely a reporting
 *    convenience.
 *
 * ## What is deliberately NOT here
 *
 * The worker never hands an unauthenticated caller someone's stored answers. The public
 * questions endpoint returns definitions only; the prefill VALUE is either rendered by
 * HubSpot from the known visitor's own contact (the CMS owns the front end, and knows who
 * is logged in — the worker does not), or read through the admin-authed staff lookup. An
 * endpoint that returned a person's dietary requirements given only their email address
 * would be a data leak wearing a convenience feature's clothes.
 */

import type {
  QuestionAnswers,
  QuestionAnswerValue,
  QuestionFieldType,
  QuestionOption,
  QuestionScope,
  RegistrationQuestion,
} from '@paddock/shared';
import type { Env } from './types';

export type { QuestionFieldType, QuestionOption, QuestionScope, RegistrationQuestion };

export const QUESTION_FIELD_TYPES: QuestionFieldType[] = [
  'text',
  'textarea',
  'select',
  'multiselect',
  'checkbox',
  'phone',
];

export const QUESTION_SCOPES: QuestionScope[] = ['attendee', 'order'];

/** Field types whose answer must come from `options_json`. */
const CHOICE_FIELD_TYPES = new Set<QuestionFieldType>(['select', 'multiselect']);

/**
 * HubSpot's own delimiter for a multiple-checkbox property value. Storing a multiselect
 * answer joined with it means the write-back is a copy rather than a re-serialisation that
 * has to keep agreeing with HubSpot's parser — and it is why an option value may not
 * contain one.
 */
export const MULTISELECT_DELIMITER = ';';

/**
 * Long enough for a real account of an allergy, short enough that the column cannot be
 * used as a document store. Matches the staff-note cap's reasoning, an order of magnitude
 * smaller because this is a form field.
 */
export const MAX_ANSWER_LENGTH = 2000;

const MAX_KEY = 60;
const MAX_LABEL = 200;
const MAX_HELP_TEXT = 500;
const MAX_PROPERTY = 100;
const MAX_OPTIONS = 100;

/** Lowercase slug: what a CSV header, a form field name and a property mapping can all be. */
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface RegistrationQuestionRow {
  id: string;
  portal_id: string;
  event_id: string | null;
  key: string;
  label: string;
  field_type: string;
  options_json: string | null;
  required: number;
  scope: string;
  hs_property: string | null;
  prefill: number;
  help_text: string | null;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegistrationAnswerRow {
  id: string;
  portal_id: string;
  registration_id: string | null;
  order_id: string | null;
  question_id: string;
  value_text: string | null;
  created_at: string;
}

/** A question plus the parts of the row only staff surfaces should see. */
export interface AdminRegistrationQuestion extends RegistrationQuestion {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseOptions(json: string | null): QuestionOption[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((entry) =>
        typeof entry === 'string'
          ? { value: entry, label: entry }
          : {
              value: String((entry as QuestionOption)?.value ?? ''),
              label: String(
                (entry as QuestionOption)?.label ?? (entry as QuestionOption)?.value ?? '',
              ),
            },
      )
      .filter((option) => option.value !== '');
  } catch {
    // A row whose options failed to parse asks an unanswerable question. Reporting it as
    // optionless is better than throwing mid-booking; the admin surface shows it as broken.
    return null;
  }
}

export function toQuestion(row: RegistrationQuestionRow): RegistrationQuestion {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    fieldType: row.field_type as QuestionFieldType,
    options: parseOptions(row.options_json),
    required: row.required === 1,
    scope: (row.scope === 'order' ? 'order' : 'attendee') as QuestionScope,
    helpText: row.help_text,
    sortOrder: row.sort_order,
    eventId: row.event_id,
    hsProperty: row.hs_property,
    prefill: row.prefill === 1,
  };
}

export function toAdminQuestion(row: RegistrationQuestionRow): AdminRegistrationQuestion {
  return {
    ...toQuestion(row),
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Display order: `sort_order`, then `key` as a deterministic tiebreak.
 *
 * The tiebreak matters more than it looks. Every question defaults to `sort_order = 0`, so
 * an unordered set is the common case — and without a stable second key the CSV's dynamic
 * columns would come out in a different order between two exports of the same event, which
 * reads as the export being unreliable.
 */
function byDisplayOrder(a: RegistrationQuestion, b: RegistrationQuestion): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * The live questions one event asks: its own, plus the tenant-wide defaults it does not
 * override.
 *
 * Reading optional config must never fail a booking (Ref 217): against a D1 that predates
 * migration 0024 this query throws "no such table", which degrades to "this event asks no
 * custom questions" — the correct reading of a portal that has defined none.
 */
export async function loadEventQuestions(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<RegistrationQuestion[]> {
  let rows: RegistrationQuestionRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM registration_questions
        WHERE portal_id = ?1 AND archived_at IS NULL
          AND (event_id IS NULL OR event_id = ?2)`,
    )
      .bind(portalId, eventId)
      .all<RegistrationQuestionRow>();
    rows = result.results;
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'registration_questions_unreadable',
        portalId,
        eventId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }

  return resolveQuestions(rows.map(toQuestion));
}

/**
 * Collapse tenant-wide and event-specific definitions to the set actually asked.
 *
 * Exported and pure so the resolution rule is testable on its own — this is the one piece
 * of behaviour an event-level override depends on, and it is easy to get backwards.
 */
export function resolveQuestions(questions: RegistrationQuestion[]): RegistrationQuestion[] {
  const byKey = new Map<string, RegistrationQuestion>();
  for (const question of questions) {
    const existing = byKey.get(question.key);
    // Event-specific wins over tenant-wide. Two rows can only share a key across those two
    // levels — the unique index forbids it within one level.
    if (!existing || (question.eventId !== null && existing.eventId === null)) {
      byKey.set(question.key, question);
    }
  }
  return [...byKey.values()].sort(byDisplayOrder);
}

/** Every definition a staff surface may list, archived rows included on request. */
export async function listQuestions(
  env: Env,
  portalId: string,
  opts: { eventId?: string | null; includeArchived?: boolean } = {},
): Promise<AdminRegistrationQuestion[]> {
  const { eventId = null, includeArchived = false } = opts;
  const result = await env.DB.prepare(
    `SELECT * FROM registration_questions
      WHERE portal_id = ?1
        AND (?2 IS NULL OR event_id IS NULL OR event_id = ?2)
        AND (?3 = 1 OR archived_at IS NULL)
      ORDER BY sort_order ASC, key ASC`,
  )
    .bind(portalId, eventId, includeArchived ? 1 : 0)
    .all<RegistrationQuestionRow>();
  return result.results.map(toAdminQuestion);
}

export async function loadQuestion(
  env: Env,
  portalId: string,
  questionId: string,
): Promise<RegistrationQuestionRow | null> {
  return env.DB.prepare('SELECT * FROM registration_questions WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, questionId)
    .first<RegistrationQuestionRow>();
}

// ---------------------------------------------------------------------------
// Definition validation (the admin side)
// ---------------------------------------------------------------------------

export interface QuestionDefinitionInput {
  key?: unknown;
  label?: unknown;
  fieldType?: unknown;
  options?: unknown;
  required?: unknown;
  scope?: unknown;
  hsProperty?: unknown;
  prefill?: unknown;
  helpText?: unknown;
  sortOrder?: unknown;
}

export interface NormalisedQuestionDefinition {
  key: string;
  label: string;
  fieldType: QuestionFieldType;
  optionsJson: string | null;
  required: number;
  scope: QuestionScope;
  hsProperty: string | null;
  prefill: number;
  helpText: string | null;
  sortOrder: number;
}

export type DefinitionResult =
  | { ok: true; definition: NormalisedQuestionDefinition }
  | { ok: false; status: string; message: string };

function text(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normaliseOptions(value: unknown): QuestionOption[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const options: QuestionOption[] = [];
  for (const entry of value.slice(0, MAX_OPTIONS)) {
    const raw =
      typeof entry === 'string'
        ? { value: entry, label: entry }
        : {
            value: (entry as QuestionOption)?.value,
            label: (entry as QuestionOption)?.label ?? (entry as QuestionOption)?.value,
          };
    const optionValue = text(raw.value, 200);
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    options.push({ value: optionValue, label: text(raw.label, 200) || optionValue });
  }
  return options.length > 0 ? options : null;
}

/**
 * Validate a question definition before it is stored.
 *
 * Every failure here is a definition that would produce an unanswerable question or an
 * unreadable answer, so each is rejected with a named status rather than silently
 * corrected: a select with no options can never be satisfied, and a multiselect option
 * containing the delimiter would come back out of storage as two different answers.
 */
export function normaliseQuestionDefinition(input: QuestionDefinitionInput): DefinitionResult {
  const key = String(input.key ?? '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_KEY);
  if (!KEY_PATTERN.test(key)) {
    return {
      ok: false,
      status: 'invalid_key',
      message: 'key must be a lowercase slug: a letter, then letters, digits or underscores',
    };
  }

  const label = text(input.label, MAX_LABEL);
  if (!label) return { ok: false, status: 'invalid_label', message: 'label is required' };

  const fieldType = String(input.fieldType ?? '').trim() as QuestionFieldType;
  if (!QUESTION_FIELD_TYPES.includes(fieldType)) {
    return {
      ok: false,
      status: 'invalid_field_type',
      message: `field_type must be one of: ${QUESTION_FIELD_TYPES.join(', ')}`,
    };
  }

  const scopeRaw = String(input.scope ?? 'attendee').trim() as QuestionScope;
  if (!QUESTION_SCOPES.includes(scopeRaw)) {
    return {
      ok: false,
      status: 'invalid_scope',
      message: `scope must be one of: ${QUESTION_SCOPES.join(', ')}`,
    };
  }

  const options = normaliseOptions(input.options);
  if (CHOICE_FIELD_TYPES.has(fieldType) && !options) {
    return {
      ok: false,
      status: 'missing_options',
      message: `A ${fieldType} question needs at least one option`,
    };
  }
  if (options?.some((option) => option.value.includes(MULTISELECT_DELIMITER))) {
    return {
      ok: false,
      status: 'invalid_option',
      message: `An option value may not contain '${MULTISELECT_DELIMITER}' — it separates multiselect values`,
    };
  }

  const hsProperty = text(input.hsProperty, MAX_PROPERTY) || null;
  // An ORDER-scoped question has no attendee to write to: the answer is about the booking,
  // and the buyer's contact is not "the person this is about" (a colleague booking four
  // seats did not personally acquire a purchase order number as a trait). Rejecting the
  // mapping is clearer than accepting it and quietly never writing anything.
  if (hsProperty && scopeRaw === 'order') {
    return {
      ok: false,
      status: 'invalid_hs_property',
      message: 'Only attendee-scoped questions can map to a contact property',
    };
  }

  return {
    ok: true,
    definition: {
      key,
      label,
      fieldType,
      optionsJson: options ? JSON.stringify(options) : null,
      required: input.required ? 1 : 0,
      scope: scopeRaw,
      hsProperty,
      // Defaults ON when a property is mapped: reuse is the reason to map one.
      prefill: hsProperty && input.prefill === false ? 0 : 1,
      helpText: text(input.helpText, MAX_HELP_TEXT) || null,
      sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Answer validation (the booking side)
// ---------------------------------------------------------------------------

export class QuestionValidationError extends Error {
  constructor(
    public readonly status: string,
    message: string,
    public readonly questionKey: string | null = null,
  ) {
    super(message);
    this.name = 'QuestionValidationError';
  }
}

/** One validated answer, ready to be written. */
export interface PreparedAnswer {
  questionId: string;
  key: string;
  /** Storage form: 'true'/'false', ';'-joined multiselect, or the text as typed. */
  value: string;
  /** Set when the question names a contact property — drives the write-back. */
  hsProperty: string | null;
  fieldType: QuestionFieldType;
}

/**
 * Normalise one supplied value to its storage form, or null for "not answered".
 *
 * Free text keeps its internal whitespace and newlines (an allergy note is a sentence, and
 * people paste them); only the ends are trimmed. `''`, `null` and an empty array all mean
 * unanswered — an empty answer is never stored, so a question that stops being asked leaves
 * the previous answer intact rather than a row of blanks.
 */
function normaliseAnswerValue(
  question: RegistrationQuestion,
  value: QuestionAnswerValue | undefined,
): string | null {
  if (value === undefined || value === null) return null;

  if (question.fieldType === 'checkbox') {
    // A false checkbox IS an answer — "no, I do not need parking" is a fact the caterer
    // and the venue both act on, and is different from having been asked nothing.
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const raw = String(value).trim().toLowerCase();
    if (raw === '') return null;
    if (['true', 'yes', 'y', '1', 'on'].includes(raw)) return 'true';
    if (['false', 'no', 'n', '0', 'off'].includes(raw)) return 'false';
    throw new QuestionValidationError(
      'invalid_answer',
      `"${question.label}" expects yes or no`,
      question.key,
    );
  }

  if (question.fieldType === 'multiselect') {
    const values = Array.isArray(value)
      ? value
      : String(value)
          .split(MULTISELECT_DELIMITER)
          .map((entry) => entry.trim());
    const allowed = new Set((question.options ?? []).map((option) => option.value));
    const chosen: string[] = [];
    for (const entry of values) {
      const candidate = String(entry).trim();
      if (candidate === '') continue;
      if (!allowed.has(candidate)) {
        throw new QuestionValidationError(
          'invalid_answer',
          `"${candidate}" is not an option for "${question.label}"`,
          question.key,
        );
      }
      if (!chosen.includes(candidate)) chosen.push(candidate);
    }
    return chosen.length === 0 ? null : chosen.join(MULTISELECT_DELIMITER);
  }

  if (Array.isArray(value)) {
    throw new QuestionValidationError(
      'invalid_answer',
      `"${question.label}" takes a single value`,
      question.key,
    );
  }

  const raw = String(value).trim();
  if (raw === '') return null;

  if (question.fieldType === 'select') {
    const allowed = new Set((question.options ?? []).map((option) => option.value));
    if (!allowed.has(raw)) {
      throw new QuestionValidationError(
        'invalid_answer',
        `"${raw}" is not an option for "${question.label}"`,
        question.key,
      );
    }
    return raw;
  }

  if (raw.length > MAX_ANSWER_LENGTH) {
    throw new QuestionValidationError(
      'answer_too_long',
      `"${question.label}" is limited to ${MAX_ANSWER_LENGTH} characters`,
      question.key,
    );
  }
  return raw;
}

/**
 * Validate one target's answers against the questions in scope.
 *
 * Throws {@link QuestionValidationError} on the first problem — the caller maps it to a
 * 400. An unknown key is an error rather than something to ignore: silently discarding it
 * means a form that was edited to ask something new appears to work, and the answers are
 * simply never recorded.
 */
export function validateAnswers(args: {
  questions: RegistrationQuestion[];
  scope: QuestionScope;
  supplied: QuestionAnswers | undefined | null;
  /** Named in the error message so a bulk booking says WHICH attendee is missing one. */
  subject?: string | null;
}): PreparedAnswer[] {
  const { questions, scope, supplied, subject = null } = args;
  const inScope = questions.filter((question) => question.scope === scope);
  const byKey = new Map(inScope.map((question) => [question.key, question]));
  const answers = supplied ?? {};

  for (const key of Object.keys(answers)) {
    if (byKey.has(key)) continue;
    // A key belonging to the OTHER scope is a front-end mistake worth naming precisely:
    // sending the booking's PO number on every attendee is easy to do and impossible to
    // debug from a generic "unknown question".
    const otherScope = questions.find((question) => question.key === key);
    throw new QuestionValidationError(
      'unknown_question',
      otherScope
        ? `"${key}" is a ${otherScope.scope}-level question and cannot be answered per ${scope}`
        : `This event does not ask "${key}"`,
      key,
    );
  }

  const prepared: PreparedAnswer[] = [];
  for (const question of inScope) {
    const value = normaliseAnswerValue(question, answers[question.key]);
    if (value === null) {
      if (question.required) {
        throw new QuestionValidationError(
          'missing_required_answer',
          subject
            ? `"${question.label}" is required for ${subject}`
            : `"${question.label}" is required`,
          question.key,
        );
      }
      continue;
    }
    prepared.push({
      questionId: question.id,
      key: question.key,
      value,
      hsProperty: question.hsProperty,
      fieldType: question.fieldType,
    });
  }
  return prepared;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Answer rows for the caller's batch.
 *
 * Statements rather than a write, so reserve puts them in the SAME D1 batch as the
 * registration they belong to. That is what "answers are persisted with the reservation"
 * means mechanically: they commit together or not at all, and a hold that expires carries
 * its answers into the same cancelled state rather than leaving them behind as orphans.
 */
export function answerStatements(
  env: Env,
  args: {
    portalId: string;
    registrationId?: string | null;
    orderId?: string | null;
    answers: PreparedAnswer[];
    createdAt: string;
  },
): D1PreparedStatement[] {
  const { portalId, registrationId = null, orderId = null, answers, createdAt } = args;
  return answers.map((answer) =>
    env.DB.prepare(
      `INSERT INTO registration_answers
         (id, portal_id, registration_id, order_id, question_id, value_text, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      registrationId,
      orderId,
      answer.questionId,
      answer.value,
      createdAt,
    ),
  );
}

/**
 * One seat's answers, as an ADMIN AMENDMENT rather than a fresh booking (Phase 3.2).
 *
 * Two things separate this from {@link validateAnswers}, and both come from the same fact:
 * the answers already exist, so silence means "leave it" rather than "unanswered".
 *
 *   PARTIAL. Only the keys actually present in the request are touched. A staff member
 *   correcting a dietary note must not blank out the coffee order they did not mention,
 *   and a form-shaped "every key, every time" validation would do exactly that.
 *
 *   EMPTY MEANS DELETE. A key present with '' / null / [] removes the stored answer —
 *   "she told us the allergy was a mistake" has to be expressible, and re-storing it as an
 *   empty string would put a blank in the caterer's export instead of nothing. Reserve
 *   cannot offer this because there is nothing there to remove.
 *
 * `required` is still enforced, on the delete side: clearing a required answer is refused,
 * exactly as failing to supply one at booking is.
 */
export interface AnswerAmendment {
  upserts: PreparedAnswer[];
  /** Questions whose stored answer is to be removed. */
  deletes: Array<{ questionId: string; key: string }>;
}

export function validateAnswerAmendments(args: {
  questions: RegistrationQuestion[];
  scope: QuestionScope;
  supplied: QuestionAnswers;
  subject?: string | null;
}): AnswerAmendment {
  const { questions, scope, supplied, subject = null } = args;
  const inScope = questions.filter((question) => question.scope === scope);
  const byKey = new Map(inScope.map((question) => [question.key, question]));

  const amendment: AnswerAmendment = { upserts: [], deletes: [] };

  for (const key of Object.keys(supplied)) {
    const question = byKey.get(key);
    if (!question) {
      // Same reasoning as validateAnswers: an unrecognised key is a mistake to name, not
      // something to drop on the floor. An archived question lands here too, which is
      // right — its answers stay readable but it can no longer be answered afresh.
      const otherScope = questions.find((entry) => entry.key === key);
      throw new QuestionValidationError(
        'unknown_question',
        otherScope
          ? `"${key}" is a ${otherScope.scope}-level question and cannot be answered per ${scope}`
          : `This event does not ask "${key}"`,
        key,
      );
    }

    const value = normaliseAnswerValue(question, supplied[key]);
    if (value === null) {
      if (question.required) {
        throw new QuestionValidationError(
          'missing_required_answer',
          subject
            ? `"${question.label}" is required for ${subject}`
            : `"${question.label}" is required`,
          question.key,
        );
      }
      amendment.deletes.push({ questionId: question.id, key: question.key });
      continue;
    }

    amendment.upserts.push({
      questionId: question.id,
      key: question.key,
      value,
      hsProperty: question.hsProperty,
      fieldType: question.fieldType,
    });
  }

  return amendment;
}

/**
 * Statements applying an amendment to one seat's stored answers, for the caller's batch.
 *
 * The upsert leans on `idx_registration_answers_unique` — one answer per question per
 * target — so a correction REPLACES the value in place rather than adding a second row
 * that an attendee list would have to choose between. `created_at` is left alone on an
 * update: it records when the question was first answered, and the amendment's own
 * timestamp lives on the registration.
 */
export function answerAmendmentStatements(
  env: Env,
  args: {
    portalId: string;
    registrationId: string;
    amendment: AnswerAmendment;
    createdAt: string;
  },
): D1PreparedStatement[] {
  const { portalId, registrationId, amendment, createdAt } = args;
  const stmts: D1PreparedStatement[] = [];

  for (const answer of amendment.upserts) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO registration_answers
           (id, portal_id, registration_id, order_id, question_id, value_text, created_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)
         ON CONFLICT (portal_id, question_id, COALESCE(registration_id, ''), COALESCE(order_id, ''))
         DO UPDATE SET value_text = excluded.value_text`,
      ).bind(
        crypto.randomUUID(),
        portalId,
        registrationId,
        answer.questionId,
        answer.value,
        createdAt,
      ),
    );
  }

  for (const removal of amendment.deletes) {
    stmts.push(
      env.DB.prepare(
        `DELETE FROM registration_answers
          WHERE portal_id = ?1 AND registration_id = ?2 AND question_id = ?3`,
      ).bind(portalId, registrationId, removal.questionId),
    );
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// Write-back to the attendee's contact
// ---------------------------------------------------------------------------

/** One answer, as the write-back handler receives it. */
export interface AnswerSyncEntry {
  key: string;
  property: string;
  value: string;
  fieldType: QuestionFieldType;
}

export interface AnswerSyncPayload {
  registrationId: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  hubspotContactId?: string | null;
  /**
   * Whether the attendee answered about THEMSELVES — the buyer and the attendee are the
   * same person. It decides whether a differing stored value may be replaced; see
   * `handleContactSyncAnswers`.
   */
  selfDeclared: boolean;
  answers: AnswerSyncEntry[];
}

/**
 * The answers worth writing back: the ones whose question names a contact property.
 *
 * A question with no mapping is about the EVENT ("which workshop stream"), and belongs in
 * D1 only. Returning an empty array means no outbox row is raised at all, so an event that
 * asks nothing mapped costs nothing.
 */
export function answersToSync(answers: PreparedAnswer[]): AnswerSyncEntry[] {
  return answers
    .filter((answer) => answer.hsProperty !== null)
    .map((answer) => ({
      key: answer.key,
      property: answer.hsProperty as string,
      value: answer.value,
      fieldType: answer.fieldType,
    }));
}

/**
 * Compare two values for "HubSpot already says this".
 *
 * Multiselect is compared as a SET: HubSpot returns a multiple-checkbox property's values
 * in its own order, and rewriting the same three choices in a different order would churn
 * the contact's timeline for nothing. Everything else compares case-insensitively on
 * collapsed whitespace, so a re-typed 'Vegetarian ' does not read as a change.
 */
export function sameAnswerValue(
  fieldType: QuestionFieldType,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (fieldType === 'multiselect') {
    const split = (value: string): string[] =>
      value
        .split(MULTISELECT_DELIMITER)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry !== '')
        .sort();
    const l = split(left);
    const r = split(right);
    return l.length === r.length && l.every((entry, index) => entry === r[index]);
  }
  return left.replace(/\s+/g, ' ').toLowerCase() === right.replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Reads for reporting and prefill
// ---------------------------------------------------------------------------

/** An answer joined to the question it answers. */
export interface AnswerWithQuestion {
  registration_id: string | null;
  order_id: string | null;
  question_id: string;
  key: string;
  label: string;
  field_type: string;
  scope: string;
  sort_order: number;
  value_text: string | null;
}

const ANSWER_JOIN = `
  SELECT a.registration_id AS registration_id,
         a.order_id        AS order_id,
         a.question_id     AS question_id,
         q.key             AS key,
         q.label           AS label,
         q.field_type      AS field_type,
         q.scope           AS scope,
         q.sort_order      AS sort_order,
         a.value_text      AS value_text
    FROM registration_answers a
    JOIN registration_questions q
      ON q.id = a.question_id AND q.portal_id = a.portal_id
`;

/**
 * Every answer given for one event, attendee- and order-scoped alike.
 *
 * The join is against `registration_questions` unfiltered by `archived_at` on purpose: an
 * archived question keeps its answers readable, which is the point of archiving rather than
 * deleting. Last year's attendee list still shows what people answered to a question nobody
 * asks any more.
 */
export async function listEventAnswers(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<AnswerWithQuestion[]> {
  const result = await env.DB.prepare(
    `${ANSWER_JOIN}
      WHERE a.portal_id = ?1
        AND (
          a.registration_id IN (
            SELECT id FROM registrations WHERE portal_id = ?1 AND event_id = ?2
          )
          OR a.order_id IN (
            SELECT id FROM orders WHERE portal_id = ?1 AND event_id = ?2
          )
        )
      ORDER BY q.sort_order ASC, q.key ASC`,
  )
    .bind(portalId, eventId)
    .all<AnswerWithQuestion>();
  return result.results;
}

/** Every answer against one registration and the order behind it. */
export async function listAnswersFor(
  env: Env,
  portalId: string,
  target: { registrationId?: string | null; orderId?: string | null },
): Promise<AnswerWithQuestion[]> {
  const registrationId = target.registrationId ?? null;
  const orderId = target.orderId ?? null;
  if (!registrationId && !orderId) return [];

  const result = await env.DB.prepare(
    `${ANSWER_JOIN}
      WHERE a.portal_id = ?1
        AND ((?2 IS NOT NULL AND a.registration_id = ?2)
          OR (?3 IS NOT NULL AND a.order_id = ?3))
      ORDER BY q.sort_order ASC, q.key ASC`,
  )
    .bind(portalId, registrationId, orderId)
    .all<AnswerWithQuestion>();
  return result.results;
}

// ---------------------------------------------------------------------------
// Tenant defaults
// ---------------------------------------------------------------------------

/**
 * The question set a newly installed tenant starts with.
 *
 * One entry, and it is the dietary field the brief asks to seed. Written here rather than
 * only in migration 0024 so a tenant that installs LATER gets it too — the migration seeds
 * the tenants that already existed, this seeds the ones that arrive afterwards, and both
 * compute the same deterministic id so neither can produce a duplicate.
 *
 * It is a DEFAULT, not a fixture: a tenant archives it in one call and keeps every answer
 * it collected.
 */
export const DEFAULT_QUESTIONS: NormalisedQuestionDefinition[] = [
  {
    key: 'dietary_requirements',
    label: 'Dietary requirements',
    fieldType: 'textarea',
    optionsJson: null,
    required: 0,
    scope: 'attendee',
    // A contact property, because this is the canonical example of an answer nobody should
    // have to type twice: it is a fact about the person, not about the course.
    hsProperty: 'dietary_requirements',
    prefill: 1,
    helpText: 'Let us know about allergies or dietary needs so catering can be arranged.',
    sortOrder: 0,
  },
];

/** Same id migration 0024's seed computes, so the two can never both take effect. */
export function defaultQuestionId(portalId: string, key: string): string {
  return `rq-${portalId}-${key}`;
}

/**
 * Seed a tenant's default questions. `INSERT OR IGNORE`, so it is safe on every install —
 * including a reinstall of a portal that has since edited or archived the row, which keeps
 * its version rather than having it silently reset.
 */
export async function seedDefaultQuestions(env: Env, portalId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await env.DB.batch(
      DEFAULT_QUESTIONS.map((definition) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO registration_questions
             (id, portal_id, event_id, key, label, field_type, options_json,
              required, scope, hs_property, prefill, help_text, sort_order,
              archived_at, created_at, updated_at)
           VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?13)`,
        ).bind(
          defaultQuestionId(portalId, definition.key),
          portalId,
          definition.key,
          definition.label,
          definition.fieldType,
          definition.optionsJson,
          definition.required,
          definition.scope,
          definition.hsProperty,
          definition.prefill,
          definition.helpText,
          definition.sortOrder,
          now,
        ),
      ),
    );
  } catch (err) {
    // Seeding a default is a convenience, never a reason to fail an install. A portal
    // whose D1 predates 0024 gets its questions when the migration runs.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'default_questions_not_seeded',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
