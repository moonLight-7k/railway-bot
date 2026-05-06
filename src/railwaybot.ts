import 'dotenv/config';

import { createHmac } from 'crypto';
import { Client, EmbedBuilder, GatewayIntentBits, TextChannel } from 'discord.js';
import express, { Request, Response } from 'express';
import { gql, GraphQLClient } from 'graphql-request';
import cron from 'node-cron';
import pRetry from 'p-retry';
import { closeDb, prepareStatements, db as storeDb } from './store';
import { processDeployEvent, autoResolveStale, cleanupOldDeploys } from './incidents';
import { registerCommands, setupInteractions, postIncidentToDiscord, sendDailyDigest } from './commands';
import { type Measurement, type WebhookBody, isValidWebhookBody, isSuccessStatus, isFailureStatus } from './types';
import { logger, logError, formatErrorForDiscord, redactSensitive } from './logger';

const RAILWAY_ENDPOINT = process.env.RAILWAY_ENDPOINT ?? 'https://backboard.railway.com/graphql/v2';
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL;
const USAGE_CHANNEL_ID = process.env.USAGE_CHANNEL;
const INCIDENT_CHANNEL_ID = process.env.INCIDENT_CHANNEL ?? LOG_CHANNEL_ID ?? '';
const RAILWAY_API_KEY = process.env.RAILWAY_API_KEY;
const WORKSPACE_ID = process.env.WORKSPACE_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR ?? '9', 10);
const USAGE_CRON = process.env.USAGE_CRON ?? '0 9 * * *';
const MONITOR_CRON = process.env.MONITOR_CRON ?? '*/5 * * * *';
const MONITOR_LOG_PATTERNS = (process.env.MONITOR_LOG_PATTERNS ?? 'ERROR,FATAL,PANIC,Uncaught,unhandledRejection,Exception,SIGKILL,OOMKilled').split(',').map(p => p.trim()).filter(Boolean);
const MONITOR_LOG_COOLDOWN_MS = parseInt(process.env.MONITOR_LOG_COOLDOWN ?? '30', 10) * 60_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const USAGE_LAST_SENT_KEY = 'usage:last_sent_at';
const HEARTBEAT_LAST_SENT_KEY = 'heartbeat:last_sent_at';

const CPU_COST_PER_UNIT = parseFloat(process.env.CPU_COST ?? '0.000463');
const MEM_COST_PER_UNIT = parseFloat(process.env.MEM_COST ?? '0.000231');
const EGRESS_COST_PER_UNIT = parseFloat(process.env.EGRESS_COST ?? '0.1');

const ICON_DARK = 'https://devicons.railway.app/i/railway-dark.svg';
const ICON_LIGHT = 'https://devicons.railway.app/i/railway-light.svg';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const graphQLClient = new GraphQLClient(RAILWAY_ENDPOINT, {
  headers: {
    Authorization: `Bearer ${RAILWAY_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10_000, // 10s timeout
  errorPolicy: 'all', // Return errors alongside data
});

const projectsQuery = gql`
query projects($workspaceId: String!) {
  projects(workspaceId: $workspaceId) {
    edges { node { id name } }
  }
}
`;

const projectUsageQuery = gql`
query projectUsage($projectId: String!) {
  usage(projectId: $projectId, measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB]) {
    value
    measurement
    tags { projectId }
  }
  estimatedUsage(projectId: $projectId, measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB]) {
    estimatedValue
    measurement
    projectId
  }
}
`;

const deploymentsQuery = gql`
query deployments($input: DeploymentListInput!) {
  deployments(input: $input, first: 1) {
    edges {
      node {
        id
        status
        createdAt
      }
    }
  }
}
`;

const deploymentLogsQuery = gql`
query deploymentLogs($deploymentId: String!) {
  deploymentLogs(deploymentId: $deploymentId, limit: 100) {
    ... on DeploymentLog {
      message
      timestamp
      severity
    }
  }
}
`;

client.once('ready', async () => {
    if (!client.user || !client.application) return;

    try {
        if (CLIENT_ID && DISCORD_TOKEN) {
            await registerCommands(client, DISCORD_TOKEN, CLIENT_ID);
        }
    } catch (err) {
        console.error('Failed to register slash commands:', err);
        await logError(`Failed to register slash commands:\n${formatError(err)}`);
    }

    setupInteractions(client);
    await reportUsageIfDue();
    await reportHeartbeatIfDue();
    console.log(`RailwayBot is online, logged in as ${client.user.tag} with id ${client.user.id}`);
});

cron.schedule(USAGE_CRON, async () => {
    await reportUsage();
    await reportHeartbeat();
    autoResolveStale(24);
    const now = new Date().toISOString();
    storeDb.cleanExpiredMutes(now);
    cleanupOldDeploys(30);
});

cron.schedule(`0 ${DIGEST_HOUR} * * *`, async () => {
    if (USAGE_CHANNEL_ID) {
        await sendDailyDigest(client, USAGE_CHANNEL_ID);
    }
});

let monitoringInProgress = false;
cron.schedule(MONITOR_CRON, async () => {
    if (monitoringInProgress) return;
    monitoringInProgress = true;
    try {
        await runMonitoringCycle();
    } finally {
        monitoringInProgress = false;
    }
});

app.get('/health', (_req: Request, res: Response) => {
    const dbOk = storeDb.getActiveIncidentCount() !== undefined;
    const discordOk = client.isReady();
    if (dbOk && discordOk) {
        res.status(200).json({ status: 'ok', discord: true, db: true });
    } else {
        res.status(503).json({ status: 'degraded', discord: discordOk, db: dbOk });
    }
});

app.post('/railway', async (req: Request, res: Response) => {
    if (WEBHOOK_SECRET) {
        const signature = req.headers['x-railway-signature'] as string | undefined;
        if (!signature || !verifyWebhookSignature((req as any).rawBody ?? JSON.stringify(req.body), signature)) {
            res.sendStatus(401);
            return;
        }
    }

    if (!isValidWebhookBody(req.body)) {
        res.sendStatus(400);
        return;
    }

    const body = req.body as WebhookBody;
    console.log(`Webhook: ${body.type} ${body.status} ${body.project.name}/${body.service.name}`);

    try {
        await processWebhook(body);
        res.sendStatus(204);
    } catch (err) {
        await logError(`Webhook processing failed:\n${formatError(err)}`);
        res.sendStatus(500);
    }
});

function verifyWebhookSignature(payload: string, signature: string): boolean {
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    return expected === signature;
}

assertRequiredEnv();
prepareStatements();
console.log('Database initialized');

app.listen(PORT, () => {
    console.log(`Webhook server is active on port ${PORT}`);
});

client.login(DISCORD_TOKEN).catch(err => {
    console.error('Failed to login to Discord:', err);
    process.exit(1);
});

async function reportUsage() {
    try {
        if (!WORKSPACE_ID) return;

        const projectsResult = await pRetry(
            async () => {
                try {
                    return await graphQLClient.request<{ projects: { edges: Array<{ node: { id: string; name: string } }> } }>(
                        projectsQuery, { workspaceId: WORKSPACE_ID }
                    );
                } catch (err) {
                    logError(err as Error, { event: 'railway_api_failure', workspaceId: WORKSPACE_ID });
                    throw new pRetry.AbortError((err as Error).message);
                }
            },
            {
                retries: 3,
                minTimeout: 1000,
                maxTimeout: 5000,
                onFailedAttempt: (error) => {
                    logger.warn(`Attempt ${error.attemptNumber} failed for workspace ${WORKSPACE_ID}. Retrying...`);
                },
            }
        );

        const usageChannel = await fetchTextChannel(USAGE_CHANNEL_ID, 'USAGE_CHANNEL');
        await usageChannel.send({ content: '**USAGE REPORT**' });

        for (const { node } of projectsResult.projects.edges) {
            try {
                const result = await pRetry(
                    async () => {
                        try {
                            return await graphQLClient.request<{
                                usage: Array<{ value: number; measurement: Measurement; tags: { projectId: string } }>;
                                estimatedUsage: Array<{ estimatedValue: number; measurement: Measurement; projectId: string }>;
                            }>(projectUsageQuery, { projectId: node.id });
                        } catch (err) {
                            logError(err as Error, { event: 'railway_api_failure', projectId: node.id, projectName: node.name });
                            throw new pRetry.AbortError((err as Error).message);
                        }
                    },
                    {
                        retries: 3,
                        minTimeout: 1000,
                        maxTimeout: 5000,
                        onFailedAttempt: (error) => {
                            logger.warn(`Attempt ${error.attemptNumber} failed for project ${node.name}. Retrying...`);
                        },
                    }
                );

                const project = buildSingleProjectUsage(node, result);
                if (project) {
                    await usageChannel.send({ embeds: [buildUsageEmbed(project)] });
                }
            } catch (err) {
                logError(err as Error, { event: 'usage_report_failure', projectId: node.id, projectName: node.name });
            }
        }

        markTaskSent(USAGE_LAST_SENT_KEY);
    } catch (err) {
        await logError(err);
    }
}

async function reportUsageIfDue() {
    if (!shouldRunDailyTask(USAGE_LAST_SENT_KEY)) return;
    await reportUsage();
}

async function reportHeartbeat() {
    try {
        const channels = new Map<string, TextChannel>();
        channels.set('LOG_CHANNEL', await fetchTextChannel(LOG_CHANNEL_ID, 'LOG_CHANNEL'));

        if (INCIDENT_CHANNEL_ID && INCIDENT_CHANNEL_ID !== LOG_CHANNEL_ID) {
            channels.set('INCIDENT_CHANNEL', await fetchTextChannel(INCIDENT_CHANNEL_ID, 'INCIDENT_CHANNEL'));
        }

        const activeIncidents = storeDb.getActiveIncidentCount();
        const message = [
            '**RAILWAYBOT HEARTBEAT**',
            'Bot is online and webhook processing is active.',
            `Active incidents: ${activeIncidents}`,
        ].join('\n');

        for (const channel of channels.values()) {
            await channel.send({ content: message });
        }

        markTaskSent(HEARTBEAT_LAST_SENT_KEY);
    } catch (err) {
        await logError(err);
    }
}

async function reportHeartbeatIfDue() {
    if (!shouldRunDailyTask(HEARTBEAT_LAST_SENT_KEY)) return;
    await reportHeartbeat();
}

function shouldRunDailyTask(stateKey: string) {
    const lastSentAt = storeDb.getAppState(stateKey);
    if (!lastSentAt) return true;

    const elapsed = Date.now() - Date.parse(lastSentAt);
    return Number.isNaN(elapsed) || elapsed >= DAILY_INTERVAL_MS;
}

function markTaskSent(stateKey: string) {
    storeDb.setAppState(stateKey, new Date().toISOString());
}

function buildSingleProjectUsage(
    node: { id: string; name: string },
    result: {
        usage: Array<{ value: number; measurement: Measurement; tags: { projectId: string } }>;
        estimatedUsage: Array<{ estimatedValue: number; measurement: Measurement; projectId: string }>;
    }
): Project | null {
    const actual: Partial<Record<Measurement, number>> = {};
    const estimated: Partial<Record<Measurement, number>> = {};

    for (const u of result.usage) { actual[u.measurement] = u.value; }
    for (const u of result.estimatedUsage) { estimated[u.measurement] = u.estimatedValue; }

    if (!hasCompleteUsage(actual) || !hasCompleteUsage(estimated)) return null;

    return {
        name: node.name, id: node.id,
        cpuUsage: actual.CPU_USAGE, memUsage: actual.MEMORY_USAGE_GB, egress: actual.NETWORK_TX_GB,
        estimatedCpuUsage: estimated.CPU_USAGE, estimatedMemUsage: estimated.MEMORY_USAGE_GB, estimatedEgress: estimated.NETWORK_TX_GB,
    };
}

function hasCompleteUsage(usage: Partial<Record<Measurement, number>> | undefined): usage is Record<Measurement, number> {
    return usage?.CPU_USAGE !== undefined && usage.MEMORY_USAGE_GB !== undefined && usage.NETWORK_TX_GB !== undefined;
}

function buildUsageEmbed(project: Project) {
    const cost = calculateCost(project.cpuUsage, project.memUsage, project.egress);
    const estCost = calculateCost(project.estimatedCpuUsage, project.estimatedMemUsage, project.estimatedEgress);
    return new EmbedBuilder()
        .setAuthor({ name: 'Usage Metrics' })
        .setTitle(project.name)
        .setDescription(`**TOTAL COST**: $${cost.toFixed(4)}\n**TOTAL ESTIMATED COST**: $${estCost.toFixed(4)}\nBreakdown below:`)
        .addFields(
            { name: 'CPU Usage', value: `${project.cpuUsage.toFixed(4)}vCores\n($${(project.cpuUsage * CPU_COST_PER_UNIT).toFixed(4)})`, inline: true },
            { name: 'Memory Usage', value: `${project.memUsage.toFixed(4)}GB\n($${(project.memUsage * MEM_COST_PER_UNIT).toFixed(4)})`, inline: true },
            { name: 'Egress', value: `${project.egress.toFixed(4)}GB\n($${(project.egress * EGRESS_COST_PER_UNIT).toFixed(4)})`, inline: true },
            { name: 'Estimated CPU', value: `${project.estimatedCpuUsage.toFixed(4)}vCores\n($${(project.estimatedCpuUsage * CPU_COST_PER_UNIT).toFixed(4)})`, inline: true },
            { name: 'Estimated Memory', value: `${project.estimatedMemUsage.toFixed(4)}GB\n($${(project.estimatedMemUsage * MEM_COST_PER_UNIT).toFixed(4)})`, inline: true },
            { name: 'Estimated Egress', value: `${project.estimatedEgress.toFixed(4)}GB\n($${(project.estimatedEgress * EGRESS_COST_PER_UNIT).toFixed(4)})`, inline: true },
        )
        .setColor('#00b0f4')
        .setFooter({ text: 'Railway Usage Metrics', iconURL: ICON_DARK })
        .setTimestamp();
}

function calculateCost(cpu: number, mem: number, egress: number) {
    return cpu * CPU_COST_PER_UNIT + mem * MEM_COST_PER_UNIT + egress * EGRESS_COST_PER_UNIT;
}

async function runMonitoringCycle() {
    const services = storeDb.listMonitoredServices();
    if (services.length === 0) return;

    for (const svc of services) {
        try {
            const result = await pRetry(
                async () => graphQLClient.request<{
                    deployments: { edges: Array<{ node: { id: string; status: string; createdAt: string } }> };
                }>(deploymentsQuery, {
                    input: { projectId: svc.project_id, serviceId: svc.service_id, environmentId: svc.environment_id },
                }),
                { retries: 2, minTimeout: 1000, maxTimeout: 3000 }
            );

            const latest = result.deployments.edges[0]?.node;
            if (!latest) {
                storeDb.updateMonitoredServiceStatus(svc.id, null, null, new Date().toISOString());
                continue;
            }

            const statusChanged = latest.status !== svc.last_known_status;
            const deploymentChanged = latest.id !== svc.last_deployment_id;

            if (!statusChanged && !deploymentChanged) {
                storeDb.updateMonitoredServiceStatus(svc.id, latest.status, latest.id, new Date().toISOString());
                continue;
            }

            if (isFailureStatus(latest.status)) {
                const event = processDeployEvent({
                    projectId: svc.project_id,
                    projectName: svc.project_name,
                    serviceId: svc.service_id,
                    serviceName: svc.service_name,
                    environment: svc.environment_name,
                    status: latest.status,
                    commitAuthor: null,
                    commitMessage: null,
                    deploymentId: latest.id,
                }, INCIDENT_CHANNEL_ID);

                if (event) {
                    const incident = storeDb.findIncidentById(event.incidentId);
                    if (incident) {
                        await postIncidentToDiscord(client, event, incident);
                    }
                }
            } else if (isSuccessStatus(latest.status)) {
                processDeployEvent({
                    projectId: svc.project_id,
                    projectName: svc.project_name,
                    serviceId: svc.service_id,
                    serviceName: svc.service_name,
                    environment: svc.environment_name,
                    status: latest.status,
                    commitAuthor: null,
                    commitMessage: null,
                    deploymentId: latest.id,
                }, INCIDENT_CHANNEL_ID);
            }

            storeDb.updateMonitoredServiceStatus(svc.id, latest.status, latest.id, new Date().toISOString());

            if (isSuccessStatus(latest.status)) {
                await scanDeploymentLogs(svc, latest.id);
            }
        } catch (err) {
            logError(err as Error, { event: 'monitor_cycle_failure', serviceId: svc.service_id, serviceName: svc.service_name });
        }
    }
}

async function scanDeploymentLogs(svc: import('./store').MonitoredServiceRow, deploymentId: string) {
    if (MONITOR_LOG_PATTERNS.length === 0) return;

    if (svc.last_log_alert_at) {
        const elapsed = Date.now() - Date.parse(svc.last_log_alert_at);
        if (!Number.isNaN(elapsed) && elapsed < MONITOR_LOG_COOLDOWN_MS) return;
    }

    try {
        const result = await pRetry(
            async () => graphQLClient.request<{
                deploymentLogs: Array<{ message: string; timestamp: string; severity: string }>;
            }>(deploymentLogsQuery, { deploymentId }),
            { retries: 1, minTimeout: 1000, maxTimeout: 3000 }
        );

        type LogEntry = { message: string; timestamp: string; severity: string };
        const logs: LogEntry[] = result.deploymentLogs ?? [];
        const errorLogs = logs.filter((log: LogEntry) =>
            MONITOR_LOG_PATTERNS.some(pattern => log.message.toLowerCase().includes(pattern.toLowerCase()))
        );

        if (errorLogs.length === 0) return;

        const channelId = INCIDENT_CHANNEL_ID || LOG_CHANNEL_ID;
        if (!channelId) return;

        const channel = await fetchTextChannel(channelId, 'INCIDENT_CHANNEL');
        const sample = errorLogs.slice(0, 5).map((l: LogEntry) => `\`${l.message.slice(0, 200)}\``).join('\n');

        const embed = new EmbedBuilder()
            .setTitle('\u{1F4CB} Runtime Log Errors Detected')
            .setDescription([
                `**Project:** ${svc.project_name}`,
                `**Service:** ${svc.service_name}`,
                `**Environment:** ${svc.environment_name}`,
                `**Matching lines:** ${errorLogs.length}`,
                '',
                '**Sample:**',
                sample,
            ].join('\n'))
            .setColor(0x9b59b6)
            .setFooter({ text: 'RailwayBot Monitor', iconURL: ICON_DARK })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
        storeDb.updateMonitoredServiceLogAlert(svc.id, new Date().toISOString());
    } catch (err) {
        logError(err as Error, { event: 'log_scan_failure', serviceId: svc.service_id });
    }
}

async function processWebhook(body: WebhookBody) {
    if (body.type !== 'DEPLOY') return;

    const commitAuthor = body.deployment.meta?.commitAuthor ?? null;
    const commitMessage = body.deployment.meta?.commitMessage ?? null;

    if (isFailureStatus(body.status)) {
        const event = processDeployEvent({
            projectId: body.project.id,
            projectName: body.project.name,
            serviceId: body.service.id,
            serviceName: body.service.name,
            environment: body.environment.name,
            status: body.status,
            commitAuthor,
            commitMessage,
            deploymentId: body.deployment.id,
        }, INCIDENT_CHANNEL_ID);

        if (event) {
            const incident = storeDb.findIncidentById(event.incidentId);
            if (incident) {
                await postIncidentToDiscord(client, event, incident);
            }
        }
    } else {
        processDeployEvent({
            projectId: body.project.id,
            projectName: body.project.name,
            serviceId: body.service.id,
            serviceName: body.service.name,
            environment: body.environment.name,
            status: body.status,
            commitAuthor,
            commitMessage,
            deploymentId: body.deployment.id,
        }, INCIDENT_CHANNEL_ID);

        const logChannel = await fetchTextChannel(LOG_CHANNEL_ID, 'LOG_CHANNEL');
        const embed = buildDeployEmbed(body.project.name, body.environment.name, body.service.name, commitMessage ?? 'No commit.', commitAuthor ?? 'No commit.', body.status);
        await logChannel.send({ embeds: [embed] });
    }
}

function buildDeployEmbed(projectName: string, environmentName: string, serviceName: string, deploymentCommit: string, deploymentCommitAuthor: string, status: string) {
    const success = isSuccessStatus(status);
    const color = success ? 0x00ff40 : 0xff0000;
    const icon = success ? '\u2705' : '\u274C';

    return new EmbedBuilder()
        .setAuthor({ name: `${icon} ${status}` })
        .setTitle(projectName)
        .setDescription(`**${status}**`)
        .addFields(
            { name: 'Environment', value: environmentName, inline: true },
            { name: 'Service', value: serviceName, inline: true },
            { name: 'Commit Author', value: deploymentCommitAuthor, inline: true },
            { name: 'Commit Message', value: deploymentCommit, inline: false },
        )
        .setColor(color)
        .setFooter({ text: 'RailwayBot', iconURL: ICON_LIGHT })
        .setTimestamp();
}

async function fetchTextChannel(channelId: string | undefined, envName: string) {
    if (!channelId) throw new Error(`${envName} is not configured.`);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`${envName} does not reference a text channel.`);
    return channel as TextChannel;
}

function assertRequiredEnv() {
    const required: Record<string, string | undefined> = {
        DISCORD_TOKEN,
        LOG_CHANNEL: LOG_CHANNEL_ID,
        USAGE_CHANNEL: USAGE_CHANNEL_ID,
        RAILWAY_API_KEY: RAILWAY_API_KEY,
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

interface Project {
    name: string;
    id: string;
    cpuUsage: number;
    memUsage: number;
    egress: number;
    estimatedCpuUsage: number;
    estimatedMemUsage: number;
    estimatedEgress: number;
}


process.on('uncaughtException', (err: unknown) => {
    logError(err as Error, { event: 'uncaughtException' });
    void logErrorToDiscord(`🚨 Uncaught Exception: ${formatErrorForDiscord(err as Error)}`).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason: unknown) => {
    logError(reason as Error, { event: 'unhandledRejection' });
    void logErrorToDiscord(`🚨 Unhandled Rejection: ${formatErrorForDiscord(reason as Error)}`);
});

async function logErrorToDiscord(message: string) {
    if (!client.isReady()) { logger.error(message); return; }
    try {
        const logChannel = await fetchTextChannel(LOG_CHANNEL_ID, 'LOG_CHANNEL');
        await logChannel.send({ content: message });
    } catch (channelError) {
        logError(channelError as Error, { event: 'discord_log_failure' });
        logger.error(message);
    }
}

function formatError(err: unknown) {
    if (err instanceof Error) return err.stack ?? err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err, null, 2);
}

function gracefulShutdown(signal: string) {
    console.log(`Received ${signal}, shutting down...`);
    try { closeDb(); console.log('Database closed.'); } catch { /* already closed */ }
    client.destroy();
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
