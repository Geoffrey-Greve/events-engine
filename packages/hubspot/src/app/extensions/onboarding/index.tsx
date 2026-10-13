import {
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Form,
  hubspot,
  Input,
  LoadingSpinner,
  Select,
  Tag,
  Text,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';
import { getExtensionProps } from '../shared/use-extension-props';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OnboardingState {
  status: string;
  refuelBillingStatus: string;
  refuelPlan: string | null;
  trialEndsAt: string | null;
  stripeProcessorConnected: boolean;
  xeroGstRateId: string | null;
  webinarProvider: string | null;
  hubdbEventsTableId: string | null;
  hubdbTicketTypesTableId: string | null;
  hubdbDynamicPageDomain: string | null;
  /** Portal default payment terms in days; null = built-in default. */
  invoiceDueDays: number | null;
  defaultInvoiceDueDays: number;
  maxInvoiceDueDays: number;
  publishingEnabled: boolean;
}

interface WebinarCreds {
  configured: boolean;
  webinarProvider: string | null;
  tenantId: string | null;
  clientId: string | null;
}

const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  scale: 'Scale',
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  active: 'success',
  installed: 'info',
  trial: 'info',
  past_due: 'warning',
  cancelled: 'error',
};

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

hubspot.extend<'home'>(({ context }) => {
  const { workerBaseUrl, authHeaders } = getExtensionProps(context);

  // Core state
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [webinarCreds, setWebinarCreds] = useState<WebinarCreds | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Xero GST form
  const [xeroRateId, setXeroRateId] = useState('');
  const [xeroSaving, setXeroSaving] = useState(false);
  const [xeroError, setXeroError] = useState<string | null>(null);

  // Webinar creds form
  const [webinarProvider, setWebinarProvider] = useState('teams');
  const [teamsTenantId, setTeamsTenantId] = useState('');
  const [teamsClientId, setTeamsClientId] = useState('');
  const [teamsClientSecret, setTeamsClientSecret] = useState('');
  const [webinarSaving, setWebinarSaving] = useState(false);
  const [webinarError, setWebinarError] = useState<string | null>(null);

  // Payment terms form (portal default hold / invoice due window for paid bookings)
  const [invoiceDueDays, setInvoiceDueDays] = useState('');
  const [termsSaving, setTermsSaving] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  // Dynamic page domain form
  const [domain, setDomain] = useState('');
  const [domainSaving, setDomainSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchOnboarding() {
    if (!workerBaseUrl) {
      setError('workerBaseUrl card property is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding`, {
        headers: authHeaders,
      });
      if (!res.ok) {
        const body = await res.text();
        setError(`Failed to load onboarding state (${res.status}): ${body}`);
        return;
      }
      const data = (await res.json()) as OnboardingState;
      setOnboarding(data);
      if (data.xeroGstRateId) setXeroRateId(data.xeroGstRateId);
      setInvoiceDueDays(data.invoiceDueDays == null ? '' : String(data.invoiceDueDays));
      if (data.hubdbDynamicPageDomain) setDomain(data.hubdbDynamicPageDomain);
      if (data.webinarProvider) setWebinarProvider(data.webinarProvider);

      // Also fetch webinar creds (non-blocking)
      const credsRes = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/onboarding/webinar-creds`,
        { headers: authHeaders },
      );
      if (credsRes.ok) {
        setWebinarCreds((await credsRes.json()) as WebinarCreds);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Mount-only: fetchOnboarding closes over stable card props for this card instance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only fetch
  useEffect(() => {
    fetchOnboarding();
  }, []);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function markStripeConnected() {
    await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/stripe`, {
      method: 'PATCH',
      headers: authHeaders,
      body: { connected: true },
    });
    await fetchOnboarding();
  }

  async function saveXeroGstRate() {
    if (!xeroRateId.trim()) return;
    setXeroSaving(true);
    setXeroError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/xero-gst`, {
        method: 'PATCH',
        headers: authHeaders,
        body: { xeroGstRateId: xeroRateId.trim() },
      });
      if (!res.ok) {
        const body = await res.text();
        setXeroError(`Save failed (${res.status}): ${body}`);
      } else {
        await fetchOnboarding();
      }
    } catch (err) {
      setXeroError(String(err));
    } finally {
      setXeroSaving(false);
    }
  }

  async function savePaymentTerms() {
    setTermsSaving(true);
    setTermsError(null);
    try {
      const trimmed = invoiceDueDays.trim();
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/payment-terms`, {
        method: 'PATCH',
        headers: authHeaders,
        body: { invoiceDueDays: trimmed === '' ? null : Number(trimmed) },
      });
      if (!res.ok) {
        const body = await res.text();
        setTermsError(`Save failed (${res.status}): ${body}`);
      } else {
        await fetchOnboarding();
      }
    } catch (err) {
      setTermsError(String(err));
    } finally {
      setTermsSaving(false);
    }
  }

  async function saveWebinarCreds() {
    setWebinarSaving(true);
    setWebinarError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/webinar-creds`, {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          provider: webinarProvider,
          tenantId: teamsTenantId.trim(),
          clientId: teamsClientId.trim(),
          clientSecret: teamsClientSecret.trim(),
        },
      });
      if (!res.ok) {
        const body = await res.text();
        setWebinarError(`Save failed (${res.status}): ${body}`);
      } else {
        setTeamsClientSecret('');
        await fetchOnboarding();
      }
    } catch (err) {
      setWebinarError(String(err));
    } finally {
      setWebinarSaving(false);
    }
  }

  async function saveDomain() {
    if (!domain.trim()) return;
    setDomainSaving(true);
    try {
      await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/dynamic-page`, {
        method: 'PATCH',
        headers: authHeaders,
        body: { domain: domain.trim() },
      });
      await fetchOnboarding();
    } finally {
      setDomainSaving(false);
    }
  }

  async function runProvisioning() {
    await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/onboarding/provision`, {
      method: 'POST',
      headers: authHeaders,
    });
    await fetchOnboarding();
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function checkIcon(done: boolean): string {
    return done ? '✓' : '○';
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) return <LoadingSpinner label="Loading Paddock setup…" />;

  if (error || !onboarding) {
    return (
      <Box>
        <Alert title="Error" variant="error">
          {error ?? 'Onboarding state unavailable.'}
        </Alert>
        <Button onClick={fetchOnboarding}>Retry</Button>
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // Compute step completion
  // ---------------------------------------------------------------------------

  const steps = {
    stripe: onboarding.stripeProcessorConnected,
    xeroGst: !!onboarding.xeroGstRateId,
    plan: onboarding.publishingEnabled,
    hubdb: !!(onboarding.hubdbEventsTableId && onboarding.hubdbTicketTypesTableId),
    dynamicPage: !!onboarding.hubdbDynamicPageDomain,
    webinar: !!onboarding.webinarProvider,
  };

  const completedCount = Object.values(steps).filter(Boolean).length;
  const totalSteps = Object.keys(steps).length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Flex direction="column" gap="medium">
      {/* ── Status header ── */}
      <Flex direction="row" gap="small" align="center" justify="between">
        <Text format={{ fontWeight: 'bold' }} variant="microcopy">
          Paddock Setup
        </Text>
        <Tag variant={STATUS_VARIANT[onboarding.status] ?? 'info'}>
          {onboarding.publishingEnabled ? 'Active' : onboarding.status}
        </Tag>
      </Flex>

      {onboarding.refuelPlan && (
        <Text variant="microcopy">
          Plan: {PLAN_LABELS[onboarding.refuelPlan] ?? onboarding.refuelPlan}
          {onboarding.trialEndsAt && ` · Trial ends ${onboarding.trialEndsAt.slice(0, 10)}`}
        </Text>
      )}

      {!onboarding.publishingEnabled && (
        <Alert title="Publishing gated" variant="warning">
          Event publishing is disabled until your Paddock subscription is active. Complete the steps
          below to go live.
        </Alert>
      )}

      <Text variant="microcopy">
        Progress: {completedCount}/{totalSteps} steps complete
      </Text>

      <Divider />

      {/* ── Step 1: Connect Stripe ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>
          {checkIcon(steps.stripe)} 1. Connect Stripe as payment processor
        </Text>
        {steps.stripe ? (
          <Tag variant="success">Connected</Tag>
        ) : (
          <Flex direction="column" gap="extra-small">
            <Text variant="microcopy">
              In HubSpot, go to Settings → Payments → Connect Stripe, then confirm below.
            </Text>
            <Button onClick={markStripeConnected} variant="secondary">
              Mark as connected
            </Button>
          </Flex>
        )}
      </Flex>

      <Divider />

      {/* ── Step 2: Import Xero GST rate ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>
          {checkIcon(steps.xeroGst)} 2. Import Xero GST rate
        </Text>
        <Text variant="microcopy">
          In HubSpot, go to Settings → Accounting → Tax rates and copy the HubSpot id for the
          Xero-imported 10% GST rate.
        </Text>
        {steps.xeroGst && <Tag variant="success">Configured: {onboarding.xeroGstRateId}</Tag>}
        <Form>
          <Input
            label="HubSpot GST tax rate ID"
            name="xeroRateId"
            value={xeroRateId}
            placeholder="e.g. 1234567"
            onChange={setXeroRateId}
          />
        </Form>
        {xeroError && (
          <Alert title="Error" variant="error">
            {xeroError}
          </Alert>
        )}
        <Button onClick={saveXeroGstRate} disabled={xeroSaving || !xeroRateId.trim()}>
          {xeroSaving ? 'Saving…' : 'Save GST rate ID'}
        </Button>
      </Flex>

      <Divider />

      {/* ── Payment terms for paid bookings ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>Payment terms for paid bookings</Text>
        <Text variant="microcopy">
          How long a paid booking keeps its seat and its payment link, and the due date written to
          the HubSpot invoice. Applies to public website, corporate portal and staff paid bookings.
          Leave blank to use the {onboarding.defaultInvoiceDueDays}-day default; maximum{' '}
          {onboarding.maxInvoiceDueDays}. A single event can override this on its Event Engine tab.
        </Text>
        <Form>
          <Input
            label="Invoice due window (days)"
            name="invoiceDueDays"
            value={invoiceDueDays}
            placeholder={String(onboarding.defaultInvoiceDueDays)}
            onChange={setInvoiceDueDays}
          />
        </Form>
        {termsError && (
          <Alert title="Error" variant="error">
            {termsError}
          </Alert>
        )}
        <Button onClick={savePaymentTerms} disabled={termsSaving}>
          {termsSaving ? 'Saving…' : 'Save payment terms'}
        </Button>
      </Flex>

      <Divider />

      {/* ── Step 3: Paddock plan ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>
          {checkIcon(steps.plan)} 3. Activate a Paddock plan
        </Text>
        {steps.plan ? (
          <Tag variant="success">
            Active — {PLAN_LABELS[onboarding.refuelPlan ?? ''] ?? onboarding.refuelPlan}
          </Tag>
        ) : (
          <Flex direction="column" gap="extra-small">
            <Text variant="microcopy">
              Contact Refuel to receive your subscription payment link. Once paid, your portal will
              be activated automatically.
            </Text>
            <Text variant="microcopy">
              Billing status: <strong>{onboarding.refuelBillingStatus}</strong>
              {onboarding.trialEndsAt
                ? ` (trial until ${onboarding.trialEndsAt.slice(0, 10)})`
                : ''}
            </Text>
          </Flex>
        )}
      </Flex>

      <Divider />

      {/* ── Step 4: HubDB tables ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>{checkIcon(steps.hubdb)} 4. Create HubDB tables</Text>
        {steps.hubdb ? (
          <Flex direction="column" gap="extra-small">
            <Tag variant="success">Tables provisioned</Tag>
            <Text variant="microcopy">Events table: {onboarding.hubdbEventsTableId}</Text>
            <Text variant="microcopy">
              Ticket types table: {onboarding.hubdbTicketTypesTableId}
            </Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="extra-small">
            <Text variant="microcopy">
              Create the events and ticket_types HubDB tables used for your dynamic event listing
              pages.
            </Text>
            <Button onClick={runProvisioning} variant="secondary">
              Create HubDB tables
            </Button>
          </Flex>
        )}
      </Flex>

      <Divider />

      {/* ── Step 5: Dynamic events page ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>
          {checkIcon(steps.dynamicPage)} 5. Set up the events listing page
        </Text>
        <Text variant="microcopy">
          In HubSpot CMS, create a dynamic page using the events HubDB table. Enter the domain where
          you published it so the Paddock module can link attendees through correctly.
        </Text>
        {steps.dynamicPage && (
          <Tag variant="success">Domain: {onboarding.hubdbDynamicPageDomain}</Tag>
        )}
        <Form>
          <Input
            label="CMS domain (e.g. events.yourdomain.com.au)"
            name="domain"
            value={domain}
            placeholder="events.yourdomain.com.au"
            onChange={setDomain}
          />
        </Form>
        <Button onClick={saveDomain} disabled={domainSaving || !domain.trim()}>
          {domainSaving ? 'Saving…' : 'Save domain'}
        </Button>
      </Flex>

      <Divider />

      {/* ── Step 6: Webinar provider ── */}
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>
          {checkIcon(steps.webinar)} 6. Webinar provider credentials (optional)
        </Text>
        <Text variant="microcopy">
          Required for online events. Skip if you only run in-person events.
        </Text>
        {webinarCreds?.configured && (
          <Flex direction="column" gap="extra-small">
            <Tag variant="success">
              {webinarCreds.webinarProvider === 'teams'
                ? 'Microsoft Teams'
                : webinarCreds.webinarProvider}{' '}
              configured
            </Tag>
            <Text variant="microcopy">Tenant ID: {webinarCreds.tenantId}</Text>
            <Text variant="microcopy">Client ID: {webinarCreds.clientId}</Text>
          </Flex>
        )}
        <Form>
          <Select
            label="Provider"
            name="webinarProvider"
            value={webinarProvider}
            onChange={(v) => setWebinarProvider(String(v))}
            options={[{ label: 'Microsoft Teams', value: 'teams' }]}
          />
          {webinarProvider === 'teams' && (
            <>
              <Input
                label="Azure Tenant ID"
                name="teamsTenantId"
                value={teamsTenantId}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                onChange={setTeamsTenantId}
              />
              <Input
                label="App Client ID"
                name="teamsClientId"
                value={teamsClientId}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                onChange={setTeamsClientId}
              />
              <Input
                label="App Client Secret"
                name="teamsClientSecret"
                value={teamsClientSecret}
                placeholder="Enter new secret to update"
                onChange={setTeamsClientSecret}
              />
            </>
          )}
        </Form>
        {webinarError && (
          <Alert title="Error" variant="error">
            {webinarError}
          </Alert>
        )}
        <Button
          onClick={saveWebinarCreds}
          disabled={
            webinarSaving ||
            (webinarProvider === 'teams' &&
              (!teamsTenantId.trim() || !teamsClientId.trim() || !teamsClientSecret.trim()))
          }
          variant="secondary"
        >
          {webinarSaving ? 'Saving…' : 'Save credentials'}
        </Button>
      </Flex>

      <Divider />

      {/* ── Summary ── */}
      <Flex direction="row" gap="small" align="center" justify="between">
        <Text variant="microcopy">
          {completedCount}/{totalSteps} steps complete
        </Text>
        <Button onClick={fetchOnboarding} variant="secondary">
          Refresh
        </Button>
      </Flex>
    </Flex>
  );
});
