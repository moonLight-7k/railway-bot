import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { logger, logError } from './logger';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'railwaybot.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
    if (_db) return _db;
    try {
        mkdirSync(path.dirname(DB_PATH), { recursive: true });
        _db = new Database(DB_PATH);
        _db.pragma('journal_mode = WAL');
        _db.pragma('foreign_keys = ON');
        migrate(_db);
        return _db;
    } catch (err) {
        logError(err as Error, { event: 'database_init_failure', path: DB_PATH });
        throw new Error(`Failed to initialize database: ${(err as Error).message}`);
    }
}

export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}

function migrate(db: Database.Database) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            service_id TEXT NOT NULL,
            service_name TEXT NOT NULL,
            environment TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'error',
            status TEXT NOT NULL DEFAULT 'triggered',
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL,
            event_count INTEGER NOT NULL DEFAULT 1,
            last_commit_author TEXT,
            last_commit_message TEXT,
            last_deployment_id TEXT,
            message_id TEXT,
            thread_id TEXT,
            channel_id TEXT,
            acknowledged_by TEXT,
            resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
        CREATE INDEX IF NOT EXISTS idx_incidents_project ON incidents(project_id);
        CREATE INDEX IF NOT EXISTS idx_incidents_last_seen ON incidents(last_seen);

        CREATE TABLE IF NOT EXISTS deploy_history (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            service_id TEXT NOT NULL,
            service_name TEXT NOT NULL,
            environment TEXT NOT NULL,
            status TEXT NOT NULL,
            commit_author TEXT,
            commit_message TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_deploys_project ON deploy_history(project_id);
        CREATE INDEX IF NOT EXISTS idx_deploys_created ON deploy_history(created_at);

        CREATE TABLE IF NOT EXISTS alert_routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT,
            service_name TEXT,
            severity TEXT,
            channel_id TEXT NOT NULL,
            UNIQUE(project_name, service_name, severity, channel_id)
        );

        CREATE TABLE IF NOT EXISTS muted_projects (
            project_id TEXT PRIMARY KEY,
            muted_until TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS monitored_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            service_id TEXT NOT NULL,
            service_name TEXT NOT NULL,
            environment_id TEXT NOT NULL,
            environment_name TEXT NOT NULL,
            last_known_status TEXT,
            last_deployment_id TEXT,
            last_log_alert_at TEXT,
            last_checked_at TEXT,
            added_by TEXT,
            UNIQUE(service_id, environment_id)
        );
    `);
}

export interface IncidentRow {
    id: string;
    fingerprint: string;
    project_id: string;
    project_name: string;
    service_id: string;
    service_name: string;
    environment: string;
    severity: string;
    status: string;
    first_seen: string;
    last_seen: string;
    event_count: number;
    last_commit_author: string | null;
    last_commit_message: string | null;
    last_deployment_id: string | null;
    message_id: string | null;
    thread_id: string | null;
    channel_id: string | null;
    acknowledged_by: string | null;
    resolved_by: string | null;
}

export interface DeployRow {
    id: string;
    project_id: string;
    project_name: string;
    service_id: string;
    service_name: string;
    environment: string;
    status: string;
    commit_author: string | null;
    commit_message: string | null;
    created_at: string;
}

export interface AlertRouteRow {
    id: number;
    project_name: string | null;
    service_name: string | null;
    severity: string | null;
    channel_id: string;
}

export interface MonitoredServiceRow {
    id: number;
    project_id: string;
    project_name: string;
    service_id: string;
    service_name: string;
    environment_id: string;
    environment_name: string;
    last_known_status: string | null;
    last_deployment_id: string | null;
    last_log_alert_at: string | null;
    last_checked_at: string | null;
    added_by: string | null;
}

interface StmtMap {
    upsertIncident: Database.Statement;
    findByFingerprint: Database.Statement;
    findIncidentById: Database.Statement;
    listActiveIncidents: Database.Statement;
    listRecentIncidents: Database.Statement;
    updateIncidentStatus: Database.Statement;
    incrementIncident: Database.Statement;
    setDiscordIds: Database.Statement;
    insertDeploy: Database.Statement;
    getDeploysSince: Database.Statement;
    deleteOldDeploys: Database.Statement;
    insertAlertRoute: Database.Statement;
    deleteAlertRoute: Database.Statement;
    findAlertRoutes: Database.Statement;
    listAlertRoutes: Database.Statement;
    muteProject: Database.Statement;
    unmuteProject: Database.Statement;
    isProjectMuted: Database.Statement;
    cleanExpiredMutes: Database.Statement;
    getActiveIncidentCount: Database.Statement;
    getTopFailingServices: Database.Statement;
    resolveOldIncidents: Database.Statement;
    getAppState: Database.Statement;
    setAppState: Database.Statement;
    insertMonitoredService: Database.Statement;
    deleteMonitoredService: Database.Statement;
    listMonitoredServices: Database.Statement;
    updateMonitoredServiceStatus: Database.Statement;
    updateMonitoredServiceLogAlert: Database.Statement;
}

let stmts: Partial<StmtMap> = {};

export function prepareStatements() {
    const db = getDb();
    stmts = {
        upsertIncident: db.prepare(`
            INSERT INTO incidents (id, fingerprint, project_id, project_name, service_id, service_name, environment, severity, status, first_seen, last_seen, event_count, last_commit_author, last_commit_message, last_deployment_id)
            VALUES (@id, @fingerprint, @projectId, @projectName, @serviceId, @serviceName, @environment, @severity, @status, @firstSeen, @lastSeen, @eventCount, @commitAuthor, @commitMessage, @deploymentId)
            ON CONFLICT(id) DO UPDATE SET
                last_seen = @lastSeen,
                event_count = event_count + 1,
                last_commit_author = @commitAuthor,
                last_commit_message = @commitMessage,
                last_deployment_id = @deploymentId
        `),
        findByFingerprint: db.prepare(`
            SELECT * FROM incidents WHERE fingerprint = ? ORDER BY last_seen DESC LIMIT 1
        `),
        findIncidentById: db.prepare(`
            SELECT * FROM incidents WHERE id = ?
        `),
        listActiveIncidents: db.prepare(`
            SELECT * FROM incidents WHERE status != 'resolved' ORDER BY last_seen DESC LIMIT ?
        `),
        listRecentIncidents: db.prepare(`
            SELECT * FROM incidents WHERE last_seen > ? ORDER BY last_seen DESC LIMIT ?
        `),
        updateIncidentStatus: db.prepare(`
            UPDATE incidents SET status = ?, acknowledged_by = COALESCE(?, acknowledged_by), resolved_by = COALESCE(?, resolved_by) WHERE id = ?
        `),
        incrementIncident: db.prepare(`
            UPDATE incidents SET last_seen = ?, event_count = event_count + 1, last_commit_author = ?, last_commit_message = ?, status = ? WHERE id = ?
        `),
        setDiscordIds: db.prepare(`
            UPDATE incidents SET message_id = ?, thread_id = ?, channel_id = ? WHERE id = ?
        `),
        insertDeploy: db.prepare(`
            INSERT OR REPLACE INTO deploy_history (id, project_id, project_name, service_id, service_name, environment, status, commit_author, commit_message, created_at)
            VALUES (@id, @projectId, @projectName, @serviceId, @serviceName, @environment, @status, @commitAuthor, @commitMessage, @createdAt)
        `),
        getDeploysSince: db.prepare(`
            SELECT * FROM deploy_history WHERE created_at > ? ORDER BY created_at DESC
        `),
        deleteOldDeploys: db.prepare(`
            DELETE FROM deploy_history WHERE created_at < ?
        `),
        insertAlertRoute: db.prepare(`
            INSERT OR IGNORE INTO alert_routes (project_name, service_name, severity, channel_id)
            VALUES (?, ?, ?, ?)
        `),
        deleteAlertRoute: db.prepare(`
            DELETE FROM alert_routes WHERE id = ?
        `),
        findAlertRoutes: db.prepare(`
            SELECT * FROM alert_routes
            WHERE (project_name IS NULL OR project_name = ?)
              AND (service_name IS NULL OR service_name = ?)
              AND (severity IS NULL OR severity = ?)
        `),
        listAlertRoutes: db.prepare(`
            SELECT * FROM alert_routes ORDER BY project_name, service_name, severity
        `),
        muteProject: db.prepare(`
            INSERT OR REPLACE INTO muted_projects (project_id, muted_until) VALUES (?, ?)
        `),
        unmuteProject: db.prepare(`
            DELETE FROM muted_projects WHERE project_id = ?
        `),
        isProjectMuted: db.prepare(`
            SELECT 1 FROM muted_projects WHERE project_id = ? AND muted_until > ?
        `),
        cleanExpiredMutes: db.prepare(`
            DELETE FROM muted_projects WHERE muted_until <= ?
        `),
        getActiveIncidentCount: db.prepare(`
            SELECT COUNT(*) as count FROM incidents WHERE status = 'triggered'
        `),
        getTopFailingServices: db.prepare(`
            SELECT project_name, service_name, COUNT(*) as incident_count, SUM(event_count) as event_count
            FROM incidents WHERE last_seen > ?
            GROUP BY project_name, service_name
            ORDER BY event_count DESC LIMIT ?
        `),
        resolveOldIncidents: db.prepare(`
            UPDATE incidents SET status = 'resolved' WHERE status != 'resolved' AND last_seen < ?
        `),
        getAppState: db.prepare(`
            SELECT value FROM app_state WHERE key = ?
        `),
        setAppState: db.prepare(`
            INSERT INTO app_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `),
        insertMonitoredService: db.prepare(`
            INSERT OR IGNORE INTO monitored_services (project_id, project_name, service_id, service_name, environment_id, environment_name, added_by)
            VALUES (@projectId, @projectName, @serviceId, @serviceName, @environmentId, @environmentName, @addedBy)
        `),
        deleteMonitoredService: db.prepare(`
            DELETE FROM monitored_services WHERE id = ?
        `),
        listMonitoredServices: db.prepare(`
            SELECT * FROM monitored_services ORDER BY project_name, service_name
        `),
        updateMonitoredServiceStatus: db.prepare(`
            UPDATE monitored_services SET last_known_status = ?, last_deployment_id = ?, last_checked_at = ? WHERE id = ?
        `),
        updateMonitoredServiceLogAlert: db.prepare(`
            UPDATE monitored_services SET last_log_alert_at = ? WHERE id = ?
        `),
    };
}

function s<K extends keyof StmtMap>(key: K): Database.Statement {
    const st = stmts[key];
    if (!st) throw new Error(`Statement ${key} not prepared`);
    return st;
}

export const db = {
    upsertIncident(params: {
        id: string; fingerprint: string; projectId: string; projectName: string;
        serviceId: string; serviceName: string; environment: string; severity: string;
        status: string; firstSeen: string; lastSeen: string; eventCount: number;
        commitAuthor: string | null; commitMessage: string | null; deploymentId: string | null;
    }) { s('upsertIncident').run(params); },

    findByFingerprint(fingerprint: string): IncidentRow | undefined {
        return s('findByFingerprint').get(fingerprint) as IncidentRow | undefined;
    },

    findIncidentById(id: string): IncidentRow | undefined {
        return s('findIncidentById').get(id) as IncidentRow | undefined;
    },

    listActiveIncidents(limit: number): IncidentRow[] {
        return s('listActiveIncidents').all(limit) as IncidentRow[];
    },

    listRecentIncidents(since: string, limit: number): IncidentRow[] {
        return s('listRecentIncidents').all(since, limit) as IncidentRow[];
    },

    updateIncidentStatus(id: string, status: string, ackBy: string | null, resolveBy: string | null) {
        s('updateIncidentStatus').run(status, ackBy, resolveBy, id);
    },

    incrementIncident(id: string, lastSeen: string, commitAuthor: string | null, commitMessage: string | null, status: string) {
        s('incrementIncident').run(lastSeen, commitAuthor, commitMessage, status, id);
    },

    setDiscordIds(id: string, messageId: string | null, threadId: string | null, channelId: string | null) {
        s('setDiscordIds').run(messageId, threadId, channelId, id);
    },

    insertDeploy(params: {
        id: string; projectId: string; projectName: string; serviceId: string;
        serviceName: string; environment: string; status: string;
        commitAuthor: string | null; commitMessage: string | null; createdAt: string;
    }) { s('insertDeploy').run(params); },

    getDeploysSince(since: string): DeployRow[] {
        return s('getDeploysSince').all(since) as DeployRow[];
    },

    deleteOldDeploys(olderThan: string): number {
        return s('deleteOldDeploys').run(olderThan).changes;
    },

    insertAlertRoute(projectName: string | null, serviceName: string | null, severity: string | null, channelId: string) {
        s('insertAlertRoute').run(projectName, serviceName, severity, channelId);
    },

    deleteAlertRoute(id: number) {
        s('deleteAlertRoute').run(id);
    },

    findAlertRoutes(projectName: string, serviceName: string, severity: string): AlertRouteRow[] {
        return s('findAlertRoutes').all(projectName, serviceName, severity) as AlertRouteRow[];
    },

    listAlertRoutes(): AlertRouteRow[] {
        return s('listAlertRoutes').all() as AlertRouteRow[];
    },

    muteProject(projectId: string, mutedUntil: string) {
        s('muteProject').run(projectId, mutedUntil);
    },

    unmuteProject(projectId: string) {
        s('unmuteProject').run(projectId);
    },

    isProjectMuted(projectId: string, now: string): boolean {
        return s('isProjectMuted').get(projectId, now) !== undefined;
    },

    cleanExpiredMutes(now: string) {
        s('cleanExpiredMutes').run(now);
    },

    getActiveIncidentCount(): number {
        return (s('getActiveIncidentCount').get() as { count: number }).count;
    },

    getTopFailingServices(since: string, limit: number) {
        return s('getTopFailingServices').all(since, limit) as Array<{
            project_name: string; service_name: string; incident_count: number; event_count: number;
        }>;
    },

    resolveOldIncidents(olderThan: string): number {
        return s('resolveOldIncidents').run(olderThan).changes;
    },

    getAppState(key: string): string | null {
        return (s('getAppState').get(key) as { value: string } | undefined)?.value ?? null;
    },

    setAppState(key: string, value: string) {
        s('setAppState').run(key, value);
    },

    insertMonitoredService(params: {
        projectId: string; projectName: string; serviceId: string; serviceName: string;
        environmentId: string; environmentName: string; addedBy: string | null;
    }): number {
        return s('insertMonitoredService').run(params).changes;
    },

    deleteMonitoredService(id: number) {
        s('deleteMonitoredService').run(id);
    },

    listMonitoredServices(): MonitoredServiceRow[] {
        return s('listMonitoredServices').all() as MonitoredServiceRow[];
    },

    updateMonitoredServiceStatus(id: number, status: string | null, deploymentId: string | null, checkedAt: string) {
        s('updateMonitoredServiceStatus').run(status, deploymentId, checkedAt, id);
    },

    updateMonitoredServiceLogAlert(id: number, alertAt: string) {
        s('updateMonitoredServiceLogAlert').run(alertAt, id);
    },
};
