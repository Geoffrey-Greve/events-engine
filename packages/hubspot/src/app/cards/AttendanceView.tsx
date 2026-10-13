import {
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  hubspot,
  LoadingSpinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Text,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';

interface WorkerEvent {
  id: string;
  capacity: number;
}

interface StatsResponse {
  eventId: string;
  capacity: number;
  registered: number;
  attended: number;
  notYetArrived: number;
  availableSeats: number;
}

function pct(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

hubspot.extend<'crm.record.tab'>(({ context }) => {
  const portalId = String(context.portal.id);
  const hubspotEventId = String(context.crm.objectId);
  const workerBaseUrl: string =
    ((context.extension as unknown as Record<string, Record<string, unknown>>)?.properties
      ?.workerBaseUrl as string) ?? '';
  const adminApiKey: string =
    ((context.extension as unknown as Record<string, Record<string, unknown>>)?.properties
      ?.adminApiKey as string) ?? '';

  const authHeaders = {
    Authorization: `Bearer ${adminApiKey}`,
    'X-Portal-Id': portalId,
  };

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  async function fetchStats() {
    if (!workerBaseUrl) {
      setError('workerBaseUrl card property is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Resolve internal event id from the HubSpot event id
      const evRes = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events?hubspotEventId=${encodeURIComponent(hubspotEventId)}`,
        { headers: authHeaders },
      );
      if (evRes.status === 404) {
        setError(
          "This event has not been registered in the worker yet. Open the 'Event Capacity & Tickets' card to set it up.",
        );
        return;
      }
      if (!evRes.ok) {
        setError(`Failed to find event (${evRes.status}): ${await evRes.text()}`);
        return;
      }
      const ev = (await evRes.json()) as WorkerEvent;

      const statsRes = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/events/${ev.id}/stats`, {
        headers: authHeaders,
      });
      if (!statsRes.ok) {
        setError(`Failed to load stats (${statsRes.status}): ${await statsRes.text()}`);
        return;
      }
      setStats((await statsRes.json()) as StatsResponse);
      setRefreshedAt(new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Adelaide' }));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once on mount
  useEffect(() => {
    fetchStats();
  }, []);

  if (loading) return <LoadingSpinner label="Loading attendance…" />;

  if (error) {
    return (
      <Box>
        <Alert title="Error" variant="error">
          {error}
        </Alert>
        <Button onClick={fetchStats}>Retry</Button>
      </Box>
    );
  }

  if (!stats) {
    return (
      <Box>
        <Text variant="microcopy">No attendance data.</Text>
      </Box>
    );
  }

  const fillPct = pct(stats.registered, stats.capacity);
  const attendPct = pct(stats.attended, stats.registered);

  return (
    <Flex direction="column" gap="medium">
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>Metric</TableCell>
            <TableCell>Count</TableCell>
            <TableCell>%</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>Capacity</TableCell>
            <TableCell>{stats.capacity}</TableCell>
            <TableCell>—</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Registered</TableCell>
            <TableCell>{stats.registered}</TableCell>
            <TableCell>{fillPct} of capacity</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Available seats</TableCell>
            <TableCell>{stats.availableSeats}</TableCell>
            <TableCell>—</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Attended (checked in)</TableCell>
            <TableCell>{stats.attended}</TableCell>
            <TableCell>{attendPct} of registered</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Not yet arrived</TableCell>
            <TableCell>{stats.notYetArrived}</TableCell>
            <TableCell>—</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Divider />

      <Flex direction="row" gap="small" justify="between">
        {refreshedAt && <Text variant="microcopy">Last refreshed: {refreshedAt} ACST</Text>}
        <Button onClick={fetchStats} disabled={loading}>
          Refresh
        </Button>
      </Flex>
    </Flex>
  );
});
