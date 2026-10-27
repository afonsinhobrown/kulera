// Única função de decisão de acesso a conteúdo (Guia Técnico 8.4).
// Proibido replicar esta lógica noutros sítios: tudo passa por canAccess.

export type WorkKind = 'ebook' | 'article' | 'physical';
export type WorkStatus = 'draft' | 'in_review' | 'published' | 'suspended';

export interface WorkAccessInfo {
  id: string;
  kind: WorkKind;
  status: WorkStatus;
  access: 'free' | 'paid';
  planIds: string[]; // planos que incluem esta obra
}

export interface PurchaseRecord {
  workId: string;
  revokedAt: Date | null;
}

export interface SubscriptionRecord {
  planId: string;
  status: 'pending' | 'active' | 'cancelled' | 'expired';
  currentPeriodEnd: Date;
}

export type AccessReason =
  | 'free'
  | 'purchased'
  | 'subscription'
  | 'not_published'
  | 'not_readable'
  | 'account_blocked'
  | 'no_entitlement';

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
}

export interface CanAccessInput {
  now: Date;
  userBlocked?: boolean;
  work: WorkAccessInfo;
  purchases: readonly PurchaseRecord[];
  subscription: SubscriptionRecord | null;
}

const allow = (reason: AccessReason): AccessDecision => ({ allowed: true, reason });
const deny = (reason: AccessReason): AccessDecision => ({ allowed: false, reason });

export function canAccess(input: CanAccessInput): AccessDecision {
  const { now, work, purchases, subscription } = input;

  if (input.userBlocked) return deny('account_blocked');
  if (work.status !== 'published') return deny('not_published');
  if (work.kind === 'physical') return deny('not_readable'); // livros físicos não se lêem na plataforma
  if (work.access === 'free') return allow('free');

  if (purchases.some((p) => p.workId === work.id && p.revokedAt === null)) {
    return allow('purchased');
  }

  if (subscription && work.planIds.includes(subscription.planId)) {
    // Subscrição cancelada mantém acesso até ao fim do período pago (RF-PLA-05).
    const statusOk = subscription.status === 'active' || subscription.status === 'cancelled';
    if (statusOk && subscription.currentPeriodEnd.getTime() > now.getTime()) {
      return allow('subscription');
    }
  }

  return deny('no_entitlement');
}
