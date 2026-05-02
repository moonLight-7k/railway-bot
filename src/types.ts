export const SUCCESS_STATUSES = ['SUCCESS', 'ACTIVE', 'RUNNING', 'DEPLOYED'] as const;
export const FAILURE_STATUSES = ['CRASHED', 'FAILED', 'BUILD_FAILED'] as const;

export type RailwayStatus = typeof SUCCESS_STATUSES[number] | typeof FAILURE_STATUSES[number] | string;

export type Measurement = 'CPU_USAGE' | 'MEMORY_USAGE_GB' | 'NETWORK_TX_GB';

export interface WebhookBody {
    type: string;
    environment: { id: string; name: string };
    project: { id: string; name: string };
    deployment: { id: string; meta?: DeploymentMeta };
    status: string;
    service: { id: string; name: string };
}

export interface DeploymentMeta {
    commitAuthor?: string;
    commitMessage?: string;
}

export function isSuccessStatus(status: string): boolean {
    return (SUCCESS_STATUSES as readonly string[]).includes(status);
}

export function isFailureStatus(status: string): boolean {
    return (FAILURE_STATUSES as readonly string[]).includes(status);
}

export function isValidWebhookBody(body: unknown): body is WebhookBody {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return (
        typeof b.type === 'string' &&
        typeof b.status === 'string' &&
        b.environment !== null && typeof b.environment === 'object' &&
        b.project !== null && typeof b.project === 'object' &&
        b.deployment !== null && typeof b.deployment === 'object' &&
        b.service !== null && typeof b.service === 'object'
    );
}
