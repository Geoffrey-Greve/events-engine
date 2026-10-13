import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const getAccessTokenMock = vi.fn();
const confirmPaymentMock = vi.fn();
const flagOversellForReviewMock = vi.fn();
const handleRefundMock = vi.fn();

vi.mock('../src/hubspot-oauth', () => ({
  getAccessToken: getAccessTokenMock,
}));

vi.mock('../src/payment', () => ({
  confirmPayment: confirmPaymentMock,
  flagOversellForReview: flagOversellForReviewMock,
  handleRefund: handleRefundMock,
}));

const { reconcileHubSpotInvoices } = await import('../src/invoice-reconcile');

interface FakeOrder {
  id: string;
  portal_id: string;
  hubspot_invoice_id: string;
  status: string;
}

function makeEnv(orders: FakeOrder[]): Env {
  const all = vi.fn(async () => ({ results: orders }));
  const bind = vi.fn(() => ({ all }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    DB: { prepare },
  } as unknown as Env;
}

function mockInvoiceStatuses(statusByInvoiceId: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const invoiceId = decodeURIComponent(url.match(/\/invoices\/([^?]+)/)?.[1] ?? '');
      const status = statusByInvoiceId[invoiceId];
      if (!status) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({ id: invoiceId, properties: { hs_invoice_status: status } }),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  getAccessTokenMock.mockReset();
  confirmPaymentMock.mockReset();
  flagOversellForReviewMock.mockReset();
  handleRefundMock.mockReset();
});

describe('reconcileHubSpotInvoices', () => {
  it('confirms paid HubSpot invoices using the payment lifecycle', async () => {
    getAccessTokenMock.mockResolvedValue('token');
    confirmPaymentMock.mockResolvedValue({ oversold: false });
    mockInvoiceStatuses({ inv_1: 'paid' });

    await reconcileHubSpotInvoices(
      makeEnv([
        { id: 'order_1', portal_id: '441838610', hubspot_invoice_id: 'inv_1', status: 'pending' },
      ]),
    );

    expect(confirmPaymentMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'confirm_payment',
      portalId: '441838610',
      hsInvoiceId: 'inv_1',
    });
    expect(flagOversellForReviewMock).not.toHaveBeenCalled();
    expect(handleRefundMock).not.toHaveBeenCalled();
  });

  it('handles oversold paid invoices via the Phase 18.3 review path', async () => {
    getAccessTokenMock.mockResolvedValue('token');
    confirmPaymentMock.mockResolvedValue({ oversold: true });
    mockInvoiceStatuses({ inv_oversold: 'paid' });

    await reconcileHubSpotInvoices(
      makeEnv([
        {
          id: 'order_oversold',
          portal_id: '441838610',
          hubspot_invoice_id: 'inv_oversold',
          status: 'cancelled',
        },
      ]),
    );

    expect(flagOversellForReviewMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'confirm_payment',
      portalId: '441838610',
      hsInvoiceId: 'inv_oversold',
    });
  });

  it('routes voided HubSpot invoices through the refund lifecycle', async () => {
    getAccessTokenMock.mockResolvedValue('token');
    mockInvoiceStatuses({ inv_void: 'voided' });

    await reconcileHubSpotInvoices(
      makeEnv([
        {
          id: 'order_void',
          portal_id: '441838610',
          hubspot_invoice_id: 'inv_void',
          status: 'pending',
        },
      ]),
    );

    expect(handleRefundMock).toHaveBeenCalledWith(expect.anything(), {
      kind: 'refund_payment',
      portalId: '441838610',
      hsInvoiceId: 'inv_void',
    });
    expect(confirmPaymentMock).not.toHaveBeenCalled();
  });

  it('ignores open invoices and leaves them for a later webhook or poll', async () => {
    getAccessTokenMock.mockResolvedValue('token');
    mockInvoiceStatuses({ inv_open: 'open' });

    await reconcileHubSpotInvoices(
      makeEnv([
        {
          id: 'order_open',
          portal_id: '441838610',
          hubspot_invoice_id: 'inv_open',
          status: 'pending',
        },
      ]),
    );

    expect(confirmPaymentMock).not.toHaveBeenCalled();
    expect(handleRefundMock).not.toHaveBeenCalled();
  });
});
