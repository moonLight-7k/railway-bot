import 'dotenv/config';

import { createHmac } from 'crypto';
import { Client, EmbedBuilder, GatewayIntentBits, TextChannel } from 'discord.js';
import express, { Request, Response } from 'express';
import { gql, GraphQLClient } from 'graphql-request';
import cron from 'node-cron';
import { closeDb, prepareStatements, db as storeDb } from './store';
import { processDeployEvent, autoResolveStale, cleanupOldDeploys } from './incidents';
import { registerCommands, setupInteractions, postIncidentToDiscord, sendDailyDigest } from './commands';
import { type Measurement, type WebhookBody, isValidWebhookBody, isSuccessStatus, isFailureStatus } from './types';

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
    headers: { Authorization: `Bearer ${RAILWAY_API_KEY}` },
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

        const projectsResult = await graphQLClient.request<{ projects: { edges: Array<{ node: { id: string; name: string } }> } }>(
            projectsQuery, { workspaceId: WORKSPACE_ID }
        );

        const usageChannel = await fetchTextChannel(USAGE_CHANNEL_ID, 'USAGE_CHANNEL');
        await usageChannel.send({ content: '**USAGE REPORT**' });

        for (const { node } of projectsResult.projects.edges) {
            try {
                const result = await graphQLClient.request<{
                    usage: Array<{ value: number; measurement: Measurement; tags: { projectId: string } }>;
                    estimatedUsage: Array<{ estimatedValue: number; measurement: Measurement; projectId: string }>;
                }>(projectUsageQuery, { projectId: node.id });

                const project = buildSingleProjectUsage(node, result);
                if (project) {
                    await usageChannel.send({ embeds: [buildUsageEmbed(project)] });
                }
            } catch (err) {
                console.error(`Usage query failed for project ${node.name}:`, err);
                await logError(`Usage query failed for project ${node.name}:\n${formatError(err)}`);
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
    console.error('Fatal error (uncaughtException):', err);
    void logError(err).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection:', reason);
    void logError(reason);
});

async function logError(err: unknown) {
    const message = formatError(err);
    if (!client.isReady()) { console.error(message); return; }
    try {
        const logChannel = await fetchTextChannel(LOG_CHANNEL_ID, 'LOG_CHANNEL');
        await logChannel.send({ content: `**Fatal error experienced:**\n\`\`\`${message.slice(0, 1900)}\`\`\`` });
    } catch (channelError) {
        console.error('Failed to report error to Discord:', channelError);
        console.error(message);
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
