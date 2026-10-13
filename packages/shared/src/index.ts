/**
 * @paddock/shared — the cross-boundary contract.
 *
 * Single source of truth for the types that span the worker ↔ HubSpot Project boundary:
 * the reserve request/response wire contract, the normalized attendance record, the
 * per-tenant config shape, the outbox kind union, and the HubDB table schemas. Both
 * @paddock/worker and @paddock/hubspot depend on this package so these shapes can never
 * drift between the two sides.
 */

export type {
  AttendanceInterval,
  AttendanceRecord,
  AttendanceRole,
  VideoEngagement,
} from './attendance';
export { syntheticInterval } from './attendance';
export type {
  BatchResponse,
  DeviceTokenResponse,
  ManifestAnswer,
  ManifestEntry,
  ManifestResponse,
  ScanOutcome,
  ScanResult,
  StatsResponse,
  TicketCodePayload,
} from './checkin';
export { normaliseManifestTickets } from './checkin';
export type {
  HubDbColumn,
  HubDbColumnType,
  HubDbSelectOption,
  HubDbTableSchema,
} from './hubdb';
export { eventsTable, hubDbTables, ticketTypesTable } from './hubdb';
export type { OutboxKind } from './outbox';
export type {
  MembershipResult,
  MembershipValueMaps,
  PricingRule,
  PricingScope,
  TaxTreatment,
} from './pricing';
export { isGstFreeTreatment, PRICES_ARE_TAX_EXCLUSIVE } from './pricing';
export type {
  EventQuestionsResponse,
  QuestionAnswers,
  QuestionAnswerValue,
  QuestionFieldType,
  QuestionOption,
  QuestionScope,
  RegistrationQuestion,
} from './questions';
export type {
  RefundKind,
  RefundOutcome,
  RefundPolicy,
  TransferRecord,
} from './refund';
export type {
  ConfirmedResponse,
  ReserveAttendee,
  ReserveBuyer,
  ReserveContactDetails,
  ReservedResponse,
  ReserveErrorResponse,
  ReserveLineItem,
  ReserveRequest,
  ReserveResponse,
  WaitlistedResponse,
} from './reserve';
export type { PortalConfig, RefuelBillingStatus, RefuelPlan, TenantStatus } from './tenant';
