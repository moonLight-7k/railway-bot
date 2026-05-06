import {
    Client,
    EmbedBuilder,
    Interaction,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ThreadChannel,
    TextChannel,
    REST,
    Routes,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
} from 'discord.js';
import * as store from './store';
import {
    type IncidentStatus,
    type Severity,
    type ProcessedEvent,
    acknowledgeIncident,
    resolveIncident,
    muteProject,
    unmuteProject,
    getSeverityColor,
    getStatusEmoji,
    getSeverityEmoji,
    autoResolveStale,
    getDeployStats,
} from './incidents';

const ACK_BUTTON_ID = 'incident_ack';
const RESOLVE_BUTTON_ID = 'incident_resolve';
const INFO_BUTTON_ID = 'incident_info';
const MUTE_1H_BUTTON_ID = 'project_mute_1h';
const MUTE_24H_BUTTON_ID = 'project_mute_24h';

const ICON_URL = 'https://devicons.railway.app/i/railway-dark.svg';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL;

const REQUIRED_PERMISSIONS = PermissionFlagsBits.ManageChannels;

function hasPermission(interaction: ChatInputCommandInteraction): boolean {
    const member = interaction.member;
    if (!member || typeof member === 'string') return false;
    const perms = (member as unknown as { permissions?: string | bigint })?.permissions;
    if (perms === undefined) return false;
    const bits = typeof perms === 'string' ? BigInt(perms) : perms;
    return (bits & BigInt(REQUIRED_PERMISSIONS)) === BigInt(REQUIRED_PERMISSIONS);
}

export async function registerCommands(client: Client, token: string, clientId: string) {
    const commands = [
        new SlashCommandBuilder()
            .setName('incident')
            .setDescription('Manage incidents')
            .addSubcommand(sub =>
                sub
                    .setName('list')
                    .setDescription('List active incidents')
                    .addIntegerOption(opt =>
                        opt.setName('limit').setDescription('Max results (default 10)').setMinValue(1).setMaxValue(25)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('ack')
                    .setDescription('Acknowledge an incident')
                    .addStringOption(opt =>
                        opt.setName('id').setDescription('Incident ID').setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('resolve')
                    .setDescription('Resolve an incident')
                    .addStringOption(opt =>
                        opt.setName('id').setDescription('Incident ID').setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('info')
                    .setDescription('Get details about an incident')
                    .addStringOption(opt =>
                        opt.setName('id').setDescription('Incident ID').setRequired(true)
                    )
            ),

        new SlashCommandBuilder()
            .setName('project')
            .setDescription('Manage project alert settings')
            .addSubcommand(sub =>
                sub
                    .setName('mute')
                    .setDescription('Mute alerts for a project')
                    .addStringOption(opt =>
                        opt.setName('project_id').setDescription('Railway project ID').setRequired(true)
                    )
                    .addIntegerOption(opt =>
                        opt.setName('duration').setDescription('Duration in minutes (default 60)').setMinValue(1)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('unmute')
                    .setDescription('Unmute alerts for a project')
                    .addStringOption(opt =>
                        opt.setName('project_id').setDescription('Railway project ID').setRequired(true)
                    )
            ),

        new SlashCommandBuilder()
            .setName('digest')
            .setDescription('Show a digest of recent activity')
            .addSubcommand(sub => sub.setName('hourly').setDescription('Show the last hour digest'))
            .addSubcommand(sub => sub.setName('daily').setDescription('Show the last 24h digest')),

        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Show Discord command help'),

        new SlashCommandBuilder()
            .setName('monitor')
            .setDescription('Manage runtime monitoring')
            .addSubcommand(sub =>
                sub
                    .setName('add')
                    .setDescription('Add a service to runtime monitoring')
                    .addStringOption(opt =>
                        opt.setName('project_id').setDescription('Railway project ID').setRequired(true)
                    )
                    .addStringOption(opt =>
                        opt.setName('service_id').setDescription('Railway service ID').setRequired(true)
                    )
                    .addStringOption(opt =>
                        opt.setName('environment_id').setDescription('Railway environment ID').setRequired(true)
                    )
                    .addStringOption(opt =>
                        opt.setName('project_name').setDescription('Display name for the project (optional)')
                    )
                    .addStringOption(opt =>
                        opt.setName('service_name').setDescription('Display name for the service (optional)')
                    )
                    .addStringOption(opt =>
                        opt.setName('environment_name').setDescription('Display name for the environment (optional)')
                    )
            )
            .addSubcommand(sub => sub.setName('list').setDescription('List all monitored services'))
            .addSubcommand(sub =>
                sub
                    .setName('remove')
                    .setDescription('Remove a service from monitoring')
                    .addIntegerOption(opt =>
                        opt.setName('id').setDescription('Monitor entry ID').setRequired(true)
                    )
            ),

        new SlashCommandBuilder()
            .setName('route')
            .setDescription('Configure alert routing')
            .addSubcommand(sub =>
                sub
                    .setName('add')
                    .setDescription('Add an alert route')
                    .addStringOption(opt =>
                        opt.setName('channel').setDescription('Discord channel ID').setRequired(true)
                    )
                    .addStringOption(opt =>
                        opt.setName('project').setDescription('Railway project name (optional)')
                    )
                    .addStringOption(opt =>
                        opt.setName('service').setDescription('Railway service name (optional)')
                    )
                    .addStringOption(opt =>
                        opt.setName('severity').setDescription('Minimum severity (optional)')
                            .addChoices(
                                { name: 'info', value: 'info' },
                                { name: 'warning', value: 'warning' },
                                { name: 'error', value: 'error' },
                                { name: 'critical', value: 'critical' },
                            )
                    )
            )
            .addSubcommand(sub => sub.setName('list').setDescription('List all alert routes'))
            .addSubcommand(sub =>
                sub
                    .setName('remove')
                    .setDescription('Remove an alert route')
                    .addIntegerOption(opt =>
                        opt.setName('id').setDescription('Route ID').setRequired(true)
                    )
            ),
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Slash commands registered');
}

export function setupInteractions(client: Client) {
    client.on('interactionCreate', async (interaction: Interaction) => {
        try {
            if (interaction.isChatInputCommand()) {
                await handleSlashCommand(interaction);
            } else if (interaction.isButton()) {
                await handleButton(interaction);
            }
        } catch (err) {
            console.error('Interaction error:', err);
            await reportErrorToDiscord(client, 'Interaction error', err);
        }
    });
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
    const { commandName } = interaction;

    const restrictedCommands = ['project', 'route', 'monitor'];
    if (restrictedCommands.includes(commandName) && !hasPermission(interaction)) {
        await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        return;
    }

    try {
        switch (commandName) {
            case 'incident': await handleIncidentCommand(interaction); break;
            case 'project': await handleProjectCommand(interaction); break;
            case 'digest': await handleDigestCommand(interaction); break;
            case 'help': await handleHelpCommand(interaction); break;
            case 'route': await handleRouteCommand(interaction); break;
            case 'monitor': await handleMonitorCommand(interaction); break;
        }
    } catch (err) {
        console.error('Command error:', err);
        await reportErrorToDiscord(interaction.client, `Command error: /${commandName}`, err);
        const msg = 'An error occurred while processing the command.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: msg, ephemeral: true });
        } else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
}

async function handleIncidentCommand(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
        case 'list': {
            const limit = interaction.options.getInteger('limit') ?? 10;
            const incidents = store.db.listActiveIncidents(limit);

            if (incidents.length === 0) {
                await interaction.reply({ content: 'No active incidents.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('\u{1F6A8} Active Incidents')
                .setColor(0xe74c3c)
                .setDescription(
                    incidents.map(inc => {
                        const statusEmoji = getStatusEmoji(inc.status as IncidentStatus);
                        const sevEmoji = getSeverityEmoji(inc.severity as Severity);
                        return `${statusEmoji} \`${inc.id.slice(0, 8)}\` ${sevEmoji} **${inc.project_name} / ${inc.service_name}** (${inc.environment})\n   Events: ${inc.event_count} | Last: <t:${Math.floor(new Date(inc.last_seen).getTime() / 1000)}:R>`;
                    }).join('\n')
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
            break;
        }
        case 'ack': {
            const id = interaction.options.getString('id', true);
            const incident = acknowledgeIncident(id, interaction.user.id);
            if (!incident) {
                await interaction.reply({ content: `Incident \`${id}\` not found or already resolved.`, ephemeral: true });
                return;
            }
            await updateIncidentDiscordMessage(incident, interaction.client);
            await interaction.reply({ content: `\u{1F7E1} Incident \`${id}\` acknowledged by <@${interaction.user.id}>.`, ephemeral: true });
            break;
        }
        case 'resolve': {
            const id = interaction.options.getString('id', true);
            const incident = resolveIncident(id, interaction.user.id);
            if (!incident) {
                await interaction.reply({ content: `Incident \`${id}\` not found.`, ephemeral: true });
                return;
            }
            await updateIncidentDiscordMessage(incident, interaction.client);
            await interaction.reply({ content: `\u{1F7E2} Incident \`${id}\` resolved by <@${interaction.user.id}>.`, ephemeral: true });
            break;
        }
        case 'info': {
            const id = interaction.options.getString('id', true);
            const incident = store.db.findIncidentById(id);
            if (!incident) {
                await interaction.reply({ content: `Incident \`${id}\` not found.`, ephemeral: true });
                return;
            }
            await interaction.reply({ embeds: [buildIncidentDetailEmbed(incident)], ephemeral: true });
            break;
        }
    }
}

async function handleProjectCommand(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
        case 'mute': {
            const projectId = interaction.options.getString('project_id', true);
            const duration = interaction.options.getInteger('duration') ?? 60;
            muteProject(projectId, duration);
            await interaction.reply({ content: `\u{1F507} Project \`${projectId}\` muted for ${duration} minutes.`, ephemeral: true });
            break;
        }
        case 'unmute': {
            const projectId = interaction.options.getString('project_id', true);
            unmuteProject(projectId);
            await interaction.reply({ content: `\u{1F50A} Project \`${projectId}\` unmuted.`, ephemeral: true });
            break;
        }
    }
}

async function handleDigestCommand(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const hours = sub === 'daily' ? 24 : 1;
    const since = new Date(Date.now() - hours * 3600000).toISOString();

    const activeCount = store.db.getActiveIncidentCount();
    const topServices = store.db.getTopFailingServices(since, 5);
    const deployStats = getDeployStats(since);
    const recentIncidents = store.db.listRecentIncidents(since, 10);

    const embed = new EmbedBuilder()
        .setTitle(`\u{1F4CA} ${hours}h Digest`)
        .setColor(0x00b0f4)
        .addFields(
            { name: 'Active Incidents', value: `${activeCount}`, inline: true },
            { name: 'Deploys', value: `${deployStats.total} total, ${deployStats.succeeded} succeeded, ${deployStats.failed} failed\nSuccess rate: ${deployStats.successRate.toFixed(1)}%`, inline: true },
        );

    if (topServices.length > 0) {
        embed.addFields({
            name: 'Top Failing Services',
            value: topServices.map((s, i) => `${i + 1}. **${s.project_name} / ${s.service_name}** - ${s.event_count} events`).join('\n'),
            inline: false,
        });
    }

    if (recentIncidents.length > 0) {
        embed.addFields({
            name: 'Recent Incidents',
            value: recentIncidents.slice(0, 5).map(inc => {
                const emoji = getStatusEmoji(inc.status as IncidentStatus);
                return `${emoji} **${inc.project_name} / ${inc.service_name}** - ${inc.event_count} events`;
            }).join('\n'),
            inline: false,
        });
    }

    embed.setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
        .setTitle('RailwayBot Help')
        .setColor(0x00b0f4)
        .setDescription('Use these commands in Discord to manage incidents, routing, digests, and project alert muting.')
        .addFields(
            {
                name: 'Incidents',
                value: [
                    '`/incident list [limit]`',
                    '`/incident ack <id>`',
                    '`/incident resolve <id>`',
                    '`/incident info <id>`',
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Projects',
                value: [
                    '`/project mute <project_id> [duration]`',
                    '`/project unmute <project_id>`',
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Digests',
                value: [
                    '`/digest hourly`',
                    '`/digest daily`',
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Routing',
                value: [
                    '`/route add <channel> [project] [service] [severity]`',
                    '`/route list`',
                    '`/route remove <id>`',
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Monitoring',
                value: [
                    '`/monitor add <project_id> <service_id> <environment_id> [names...]`',
                    '`/monitor list`',
                    '`/monitor remove <id>`',
                ].join('\n'),
                inline: false,
            },
            {
                name: 'Incident Buttons',
                value: '`Acknowledge`, `Resolve`, `Info`, `Mute 1h`, `Mute 24h`',
                inline: false,
            },
            {
                name: 'Permissions',
                value: '`/project *`, `/route *`, and `/monitor *` require `Manage Channels`.',
                inline: false,
            },
        )
        .setFooter({ text: 'RailwayBot', iconURL: ICON_URL })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRouteCommand(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
        case 'add': {
            const channel = interaction.options.getString('channel', true);
            const project = interaction.options.getString('project');
            const service = interaction.options.getString('service');
            const severity = interaction.options.getString('severity');

            const targetChannel = await interaction.client.channels.fetch(channel).catch(() => null);
            if (!targetChannel?.isTextBased()) {
                await interaction.reply({ content: `Channel <#${channel}> not found or not a text channel.`, ephemeral: true });
                return;
            }

            store.db.insertAlertRoute(project, service, severity, channel);
            await interaction.reply({
                content: `\u{2705} Alert route added: ${project ?? '*'} / ${service ?? '*'} [${severity ?? '*'}] -> <#${channel}>`,
                ephemeral: true,
            });
            break;
        }
        case 'list': {
            const routes = store.db.listAlertRoutes();
            if (routes.length === 0) {
                await interaction.reply({ content: 'No alert routes configured.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('\u{1F517} Alert Routes')
                .setDescription(routes.map(r => `\`#${r.id}\` ${r.project_name ?? '*'} / ${r.service_name ?? '*'} [${r.severity ?? '*'}] -> <#${r.channel_id}>`).join('\n'))
                .setColor(0x00b0f4);

            await interaction.reply({ embeds: [embed], ephemeral: true });
            break;
        }
        case 'remove': {
            const id = interaction.options.getInteger('id', true);
            store.db.deleteAlertRoute(id);
            await interaction.reply({ content: `\u{1F5D1}\uFE0F Route #${id} removed.`, ephemeral: true });
            break;
        }
    }
}

async function handleMonitorCommand(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
        case 'add': {
            const projectId = interaction.options.getString('project_id', true);
            const serviceId = interaction.options.getString('service_id', true);
            const environmentId = interaction.options.getString('environment_id', true);
            const projectName = interaction.options.getString('project_name') ?? projectId;
            const serviceName = interaction.options.getString('service_name') ?? serviceId;
            const environmentName = interaction.options.getString('environment_name') ?? environmentId;

            const changes = store.db.insertMonitoredService({
                projectId,
                projectName,
                serviceId,
                serviceName,
                environmentId,
                environmentName,
                addedBy: interaction.user.id,
            });

            if (changes === 0) {
                await interaction.reply({ content: `This service/environment combination is already being monitored.`, ephemeral: true });
            } else {
                await interaction.reply({ content: `\u{1F4E1} Now monitoring **${serviceName}** in **${environmentName}** (project: ${projectName}).`, ephemeral: true });
            }
            break;
        }
        case 'list': {
            const services = store.db.listMonitoredServices();
            if (services.length === 0) {
                await interaction.reply({ content: 'No services are being monitored.', ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('\u{1F4E1} Monitored Services')
                .setColor(0x9b59b6)
                .setDescription(
                    services.map(s => {
                        const status = s.last_known_status ?? 'unknown';
                        const lastCheck = s.last_checked_at
                            ? `<t:${Math.floor(new Date(s.last_checked_at).getTime() / 1000)}:R>`
                            : 'never';
                        return `\`#${s.id}\` **${s.project_name} / ${s.service_name}** (${s.environment_name})\n   Status: ${status} | Last check: ${lastCheck}`;
                    }).join('\n')
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
            break;
        }
        case 'remove': {
            const id = interaction.options.getInteger('id', true);
            store.db.deleteMonitoredService(id);
            await interaction.reply({ content: `\u{1F5D1}\uFE0F Monitor entry #${id} removed.`, ephemeral: true });
            break;
        }
    }
}

async function handleButton(interaction: Interaction) {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    const [, incidentId] = customId.split(':');
    if (!incidentId) return;

    if (customId.startsWith(ACK_BUTTON_ID)) {
        const incident = acknowledgeIncident(incidentId, interaction.user.id);
        if (incident) await updateIncidentDiscordMessage(incident, interaction.client);
        await interaction.reply({ content: incident ? '\u{1F7E1} Acknowledged.' : 'Incident not found.', ephemeral: true });
    } else if (customId.startsWith(RESOLVE_BUTTON_ID)) {
        const incident = resolveIncident(incidentId, interaction.user.id);
        if (incident) await updateIncidentDiscordMessage(incident, interaction.client);
        await interaction.reply({ content: incident ? '\u{1F7E2} Resolved.' : 'Incident not found.', ephemeral: true });
    } else if (customId.startsWith(INFO_BUTTON_ID)) {
        const incident = store.db.findIncidentById(incidentId);
        await interaction.reply({
            embeds: incident ? [buildIncidentDetailEmbed(incident)] : [],
            content: incident ? undefined : 'Incident not found.',
            ephemeral: true,
        });
    } else if (customId.startsWith(MUTE_1H_BUTTON_ID)) {
        const incident = store.db.findIncidentById(incidentId);
        if (incident) {
            muteProject(incident.project_id, 60);
            await interaction.reply({ content: `\u{1F507} Project **${incident.project_name}** muted for 1 hour.`, ephemeral: true });
        } else {
            await interaction.reply({ content: 'Incident not found.', ephemeral: true });
        }
    } else if (customId.startsWith(MUTE_24H_BUTTON_ID)) {
        const incident = store.db.findIncidentById(incidentId);
        if (incident) {
            muteProject(incident.project_id, 1440);
            await interaction.reply({ content: `\u{1F507} Project **${incident.project_name}** muted for 24 hours.`, ephemeral: true });
        } else {
            await interaction.reply({ content: 'Incident not found.', ephemeral: true });
        }
    }
}

export function buildIncidentEmbed(event: ProcessedEvent): EmbedBuilder {
    const color = getSeverityColor(event.severity);
    const statusEmoji = getStatusEmoji(event.status);
    const sevEmoji = getSeverityEmoji(event.severity);

    const title = event.isNew
        ? `${sevEmoji} New Incident`
        : event.isRegressed
            ? `${sevEmoji} Incident Regressed`
            : `${statusEmoji} Incident Updated`;

    const description = [
        `**Project:** ${event.projectName}`,
        `**Service:** ${event.serviceName}`,
        `**Environment:** ${event.environment}`,
        `**Severity:** ${sevEmoji} ${event.severity.toUpperCase()}`,
        `**Status:** ${statusEmoji} ${event.status}`,
        `**Events:** ${event.eventCount}`,
        event.commitAuthor ? `**Author:** ${event.commitAuthor}` : null,
        event.commitMessage ? `**Commit:** ${event.commitMessage}` : null,
    ].filter(Boolean).join('\n');

    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setFooter({ text: `Incident ${event.incidentId}`, iconURL: ICON_URL })
        .setTimestamp();
}

export function buildIncidentActionRow(incidentId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${ACK_BUTTON_ID}:${incidentId}`).setLabel('Acknowledge').setStyle(ButtonStyle.Secondary).setEmoji('\u{1F7E1}'),
        new ButtonBuilder().setCustomId(`${RESOLVE_BUTTON_ID}:${incidentId}`).setLabel('Resolve').setStyle(ButtonStyle.Success).setEmoji('\u{1F7E2}'),
        new ButtonBuilder().setCustomId(`${INFO_BUTTON_ID}:${incidentId}`).setLabel('Info').setStyle(ButtonStyle.Primary).setEmoji('\u2139\uFE0F'),
        new ButtonBuilder().setCustomId(`${MUTE_1H_BUTTON_ID}:${incidentId}`).setLabel('Mute 1h').setStyle(ButtonStyle.Secondary).setEmoji('\u{1F507}'),
        new ButtonBuilder().setCustomId(`${MUTE_24H_BUTTON_ID}:${incidentId}`).setLabel('Mute 24h').setStyle(ButtonStyle.Secondary).setEmoji('\u{1F507}'),
    );
}

export function buildIncidentDetailEmbed(incident: store.IncidentRow): EmbedBuilder {
    const statusEmoji = getStatusEmoji(incident.status as IncidentStatus);
    const sevEmoji = getSeverityEmoji(incident.severity as Severity);
    const color = getSeverityColor(incident.severity as Severity);

    return new EmbedBuilder()
        .setTitle(`${statusEmoji} Incident Detail`)
        .setDescription([
            `**ID:** \`${incident.id}\``,
            `**Project:** ${incident.project_name} (\`${incident.project_id}\`)`,
            `**Service:** ${incident.service_name} (\`${incident.service_id}\`)`,
            `**Environment:** ${incident.environment}`,
            `**Severity:** ${sevEmoji} ${incident.severity}`,
            `**Status:** ${statusEmoji} ${incident.status}`,
            `**Events:** ${incident.event_count}`,
            `**First Seen:** <t:${Math.floor(new Date(incident.first_seen).getTime() / 1000)}:R>`,
            `**Last Seen:** <t:${Math.floor(new Date(incident.last_seen).getTime() / 1000)}:R>`,
            incident.last_commit_author ? `**Author:** ${incident.last_commit_author}` : null,
            incident.last_commit_message ? `**Commit:** ${incident.last_commit_message}` : null,
            incident.acknowledged_by ? `**Ack By:** <@${incident.acknowledged_by}>` : null,
            incident.resolved_by ? `**Resolved By:** ${incident.resolved_by}` : null,
        ].filter(Boolean).join('\n'))
        .setColor(color)
        .setFooter({ text: 'RailwayBot Incident', iconURL: ICON_URL })
        .setTimestamp();
}

async function updateIncidentDiscordMessage(incident: store.IncidentRow, discordClient: Client) {
    if (!incident.message_id || !incident.channel_id) return;

    try {
        const channel = await discordClient.channels.fetch(incident.channel_id);
        if (!channel?.isTextBased()) return;

        const message = await (channel as TextChannel).messages.fetch(incident.message_id);

        const event: ProcessedEvent = {
            incidentId: incident.id,
            fingerprint: incident.fingerprint,
            projectId: incident.project_id,
            projectName: incident.project_name,
            serviceId: incident.service_id,
            serviceName: incident.service_name,
            environment: incident.environment,
            severity: incident.severity as Severity,
            status: incident.status as IncidentStatus,
            isNew: false,
            isRegressed: false,
            eventCount: incident.event_count,
            commitAuthor: incident.last_commit_author,
            commitMessage: incident.last_commit_message,
            deploymentId: incident.last_deployment_id,
            channelId: incident.channel_id,
        };

        const embed = buildIncidentEmbed(event);
        const row = buildIncidentActionRow(incident.id);
        await message.edit({ embeds: [embed], components: [row] });
    } catch (err) {
        console.error('Failed to update incident Discord message:', err);
        await reportErrorToDiscord(discordClient, 'Failed to update incident Discord message', err);
    }
}

export async function postIncidentToDiscord(
    client: Client,
    event: ProcessedEvent,
    incident: store.IncidentRow,
) {
    const channelId = event.channelId;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const textChannel = channel as TextChannel;
    const embed = buildIncidentEmbed(event);
    const row = buildIncidentActionRow(event.incidentId);

    const existingMsgId = incident.message_id;
    const existingChannelId = incident.channel_id;

    if (existingMsgId && existingChannelId) {
        try {
            const existingChannel = await client.channels.fetch(existingChannelId);
            if (existingChannel?.isTextBased()) {
                const existingMessage = await (existingChannel as TextChannel).messages.fetch(existingMsgId);
                await existingMessage.edit({ embeds: [embed], components: [row] });

                if (incident.thread_id) {
                    try {
                        const thread = await client.channels.fetch(incident.thread_id);
                        if (thread?.isThread()) {
                            await (thread as ThreadChannel).send(
                                `${getStatusEmoji(event.status)} Updated: **${event.status}** | Events: ${event.eventCount}${event.commitMessage ? ` | ${event.commitMessage}` : ''}`
                            );
                        }
                    } catch (err) {
                        console.error('Failed to post in incident thread:', err);
                        await reportErrorToDiscord(client, 'Failed to post in incident thread', err);
                    }
                }

                return;
            }
        } catch (err) {
            console.error('Failed to update existing incident message, creating new one:', err);
            await reportErrorToDiscord(client, 'Failed to update existing incident message', err);
        }
    }

    const sent = await textChannel.send({ embeds: [embed], components: [row] });
    store.db.setDiscordIds(incident.id, sent.id, null, textChannel.id);

    try {
        const thread = await sent.startThread({
            name: `\u{1F6A8} ${event.projectName} / ${event.serviceName} (${event.severity})`,
            autoArchiveDuration: 1440,
        });
        store.db.setDiscordIds(incident.id, sent.id, thread.id, textChannel.id);

        await thread.send(
            `Incident thread created.\nProject: **${event.projectName}**\nService: **${event.serviceName}**\nEnvironment: **${event.environment}**\nSeverity: **${event.severity}**\nUse buttons on the parent message or slash commands to manage.`
        );
    } catch (err) {
        console.error('Failed to create incident thread:', err);
        await reportErrorToDiscord(client, 'Failed to create incident thread', err);
    }
}

async function reportErrorToDiscord(client: Client, context: string, err: unknown) {
    if (!LOG_CHANNEL_ID) return;

    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!channel?.isTextBased()) return;

        const message = formatError(err).slice(0, 1800);
        await (channel as TextChannel).send({ content: `**${context}:**\n\`\`\`${message}\`\`\`` });
    } catch (channelError) {
        console.error('Failed to report command error to Discord:', channelError);
    }
}

function formatError(err: unknown) {
    if (err instanceof Error) return err.stack ?? err.message;
    if (typeof err === 'string') return err;
    return JSON.stringify(err, null, 2);
}

export async function sendDailyDigest(client: Client, channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const activeCount = store.db.getActiveIncidentCount();
    const topServices = store.db.getTopFailingServices(since, 5);
    const deployStats = getDeployStats(since);
    const resolved = autoResolveStale(24);

    const embed = new EmbedBuilder()
        .setTitle('\u{1F4CA} Daily Digest')
        .setColor(0x00b0f4)
        .setDescription(
            [
                `**Active Incidents:** ${activeCount}`,
                `**Deploys (24h):** ${deployStats.total} total, ${deployStats.succeeded} ok, ${deployStats.failed} failed (${deployStats.successRate.toFixed(1)}% success)`,
                resolved > 0 ? `**Auto-resolved:** ${resolved} stale incidents` : null,
            ].filter(Boolean).join('\n')
        );

    if (topServices.length > 0) {
        embed.addFields({
            name: 'Top Failing Services',
            value: topServices.map((s, i) => `${i + 1}. **${s.project_name} / ${s.service_name}** - ${s.event_count} events`).join('\n'),
            inline: false,
        });
    }

    embed.setFooter({ text: 'RailwayBot', iconURL: ICON_URL }).setTimestamp();

    await (channel as TextChannel).send({ embeds: [embed] });
}
