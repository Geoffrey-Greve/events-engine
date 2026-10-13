/**
 * Extracts workerBaseUrl, adminApiKey, portalId, and a ready-made authHeaders
 * object from the extension context properties. Centralises this extraction so
 * it doesn't have to be copy-pasted into every App Card / App Home extension.
 *
 * Usage:
 *   hubspot.extend<"crm.record.tab">(({ context }) => {
 *     const { workerBaseUrl, portalId, authHeaders } = getExtensionProps(context);
 *     ...
 *   });
 */

export interface ExtensionProps {
  workerBaseUrl: string;
  adminApiKey: string;
  portalId: string;
  /**
   * HubSpot user id of whoever has the card open, or '' when the context omits it.
   * Recorded as the author of a staff note so a thread reads as a conversation between
   * named people rather than an anonymous log.
   */
  userId: string;
  authHeaders: Record<string, string>;
}

export function getExtensionProps(context: {
  portal: { id: number | string };
  user?: { id?: number | string };
  extension?: unknown;
}): ExtensionProps {
  const portalId = String(context.portal.id);
  const userId = context.user?.id == null ? '' : String(context.user.id);
  const props =
    (context.extension as Record<string, Record<string, unknown>> | undefined)?.properties ?? {};

  const workerBaseUrl = (props.workerBaseUrl as string) ?? '';
  const adminApiKey = (props.adminApiKey as string) ?? '';

  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${adminApiKey}`,
    'X-Portal-Id': portalId,
    'Content-Type': 'application/json',
  };

  return { workerBaseUrl, adminApiKey, portalId, userId, authHeaders };
}
