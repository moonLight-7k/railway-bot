import { createHash } from 'crypto';
import * as store from './store';
import { isSuccessStatus, isFailureStatus, FAILURE_STATUSES } from './types';

export type Severity = 'info' | 'warning' | 'error' | 'critical';
export type IncidentStatus = 'triggered' | 'acknowledged' | 'resolved' | 'regressed';

export interface ProcessedEvent {
    incidentId: string;
    fingerprint: string;
    projectId: string;
    projectName: string;
    serviceId: string;
    serviceName: string;
    environment: string;
    severity: Severity;
    status: IncidentStatus;
    isNew: boolean;
    isRegressed: boolean;
    eventCount: number;
    commitAuthor: string | null;
    commitMessage: string | null;
    deploymentId: string | null;
    channelId: string;
}

const FINGERPRINT_LENGTH = 16;

const SEVERITY_COLORS: Record<Severity, number> = {
    info: 0x3498db,
    warning: 0xf39c12,
    error: 0xe74c3c,
    critical: 0x8b0000,
};

const STATUS_EMOJI: Record<IncidentStatus, string> = {
    triggered: '\u{1F534}',
    acknowledged: '\u{1F7E1}',
    resolved: '\u{1F7E2}',
    regressed: '\u{1F7E0}',
};

const SEVERITY_EMOJI: Record<Severity, string> = {
    info: '\u{2139}\uFE0F',
    warning: '\u{26A0}\uFE0F',
    error: '\u{1F6A8}',
    critical: '\u{1F6D1}',
};

export function getSeverityColor(severity: Severity): number {
    return SEVERITY_COLORS[severity];
}

export function getStatusEmoji(status: IncidentStatus): string {
    return STATUS_EMOJI[status];
}

export function getSeverityEmoji(severity: Severity): string {
    return SEVERITY_EMOJI[severity];
}

export function classifySeverity(status: string, environment: string): Severity {
    if (status === 'CRASHED') {
        if (environment.toLowerCase() === 'production') return 'critical';
        return 'error';
    }

    if (status === 'BUILD_FAILED' || status === 'FAILED') {
        return 'error';
    }

    if (status === 'RESTARTING' || status === 'DEPLOYING') {
        return 'warning';
    }

    return 'info';
}

export function computeFingerprint(projectId: string, serviceId: string, environment: string, status: string): string {
    const raw = `${projectId}:${serviceId}:${environment}:${status}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

export function resolveChannelForEvent(
    projectName: string,
    serviceName: string,
    severity: Severity,
    fallbackChannelId: string,
): string {
    const exactRoutes = store.db.findAlertRoutes(projectName, serviceName, severity);
    if (exactRoutes.length > 0) return exactRoutes[0].channel_id;

    const projectRoutes = store.db.findAlertRoutes(projectName, '', severity);
    if (projectRoutes.length > 0) return projectRoutes[0].channel_id;

    const severityRoutes = store.db.findAlertRoutes('', '', severity);
    if (severityRoutes.length > 0) return severityRoutes[0].channel_id;

    return fallbackChannelId;
}

export function processDeployEvent(event: {
    projectId: string;
    projectName: string;
    serviceId: string;
    serviceName: string;
    environment: string;
    status: string;
    commitAuthor: string | null;
    commitMessage: string | null;
    deploymentId: string;
}, fallbackChannelId: string, now?: string): ProcessedEvent | null {
    const ts = now ?? new Date().toISOString();

    store.db.insertDeploy({
        id: event.deploymentId,
        projectId: event.projectId,
        projectName: event.projectName,
        serviceId: event.serviceId,
        serviceName: event.serviceName,
        environment: event.environment,
        status: event.status,
        commitAuthor: event.commitAuthor,
        commitMessage: event.commitMessage,
        createdAt: ts,
    });

    if (isSuccessStatus(event.status)) {
        handleSuccessfulDeploy(event);
        return null;
    }

    if (store.db.isProjectMuted(event.projectId, ts)) {
        return null;
    }

    const severity = classifySeverity(event.status, event.environment);
    const fingerprint = computeFingerprint(event.projectId, event.serviceId, event.environment, event.status);
    const incidentId = fingerprint;

    const existing = store.db.findByFingerprint(fingerprint);
    const isNew = !existing;

    let status: IncidentStatus = 'triggered';
    let isRegressed = false;
    let eventCount = 1;

    if (existing) {
        if (existing.status === 'resolved') {
            status = 'regressed';
            isRegressed = true;
        } else {
            status = existing.status as IncidentStatus;
        }

        eventCount = existing.event_count + 1;
        store.db.incrementIncident(existing.id, ts, event.commitAuthor, event.commitMessage, status);
    } else {
        store.db.upsertIncident({
            id: incidentId,
            fingerprint,
            projectId: event.projectId,
            projectName: event.projectName,
            serviceId: event.serviceId,
            serviceName: event.serviceName,
            environment: event.environment,
            severity,
            status,
            firstSeen: ts,
            lastSeen: ts,
            eventCount: 1,
            commitAuthor: event.commitAuthor,
            commitMessage: event.commitMessage,
            deploymentId: event.deploymentId,
        });
    }

    const channelId = resolveChannelForEvent(event.projectName, event.serviceName, severity, fallbackChannelId);

    return {
        incidentId: existing?.id ?? incidentId,
        fingerprint,
        projectId: event.projectId,
        projectName: event.projectName,
        serviceId: event.serviceId,
        serviceName: event.serviceName,
        environment: event.environment,
        severity,
        status,
        isNew,
        isRegressed,
        eventCount,
        commitAuthor: event.commitAuthor,
        commitMessage: event.commitMessage,
        deploymentId: event.deploymentId,
        channelId,
    };
}

function handleSuccessfulDeploy(event: {
    projectId: string;
    serviceId: string;
    environment: string;
}) {
    for (const failureStatus of FAILURE_STATUSES) {
        const fingerprint = computeFingerprint(event.projectId, event.serviceId, event.environment, failureStatus);
        const existing = store.db.findByFingerprint(fingerprint);
        if (existing && existing.status !== 'resolved') {
            store.db.updateIncidentStatus(existing.id, 'resolved', null, 'auto:successful-deploy');
        }
    }
}

export function acknowledgeIncident(incidentId: string, userId: string): store.IncidentRow | null {
    const incident = store.db.findIncidentById(incidentId);
    if (!incident || incident.status === 'resolved') return null;

    store.db.updateIncidentStatus(incidentId, 'acknowledged', userId, null);
    return store.db.findIncidentById(incidentId) ?? null;
}

export function resolveIncident(incidentId: string, userId: string): store.IncidentRow | null {
    const incident = store.db.findIncidentById(incidentId);
    if (!incident) return null;

    store.db.updateIncidentStatus(incidentId, 'resolved', null, userId);
    return store.db.findIncidentById(incidentId) ?? null;
}

export function muteProject(projectId: string, durationMinutes: number) {
    const mutedUntil = new Date(Date.now() + durationMinutes * 60000).toISOString();
    store.db.muteProject(projectId, mutedUntil);
}

export function unmuteProject(projectId: string) {
    store.db.unmuteProject(projectId);
}

export function autoResolveStale(staleAfterHours: number = 24): number {
    const cutoff = new Date(Date.now() - staleAfterHours * 3600000).toISOString();
    return store.db.resolveOldIncidents(cutoff);
}

export function getDeployStats(since: string) {
    const deploys = store.db.getDeploysSince(since);
    const total = deploys.length;
    if (total === 0) {
        return { total: 0, succeeded: 0, failed: 0, successRate: 0 };
    }
    const succeeded = deploys.filter(d => isSuccessStatus(d.status)).length;
    const failed = deploys.filter(d => isFailureStatus(d.status)).length;
    return { total, succeeded, failed, successRate: (succeeded / total) * 100 };
}

export function cleanupOldDeploys(maxAgeDays: number = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    return store.db.deleteOldDeploys(cutoff);
}
