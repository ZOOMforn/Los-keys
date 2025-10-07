const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const config = {
    token: process.env.DISCORD_TOKEN || 'SEU_TOKEN_DO_BOT',
    port: process.env.PORT || 3000,
    databaseUrl: process.env.DATABASE_URL || 'postgresql://user:password@localhost/keys_db'
};

const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
    console.error('❌ Erro no pool PostgreSQL:', err);
});

const dbRun = async (sql, params = []) => {
    const client = await pool.connect();
    try {
        return await client.query(sql, params);
    } finally {
        client.release();
    }
};

const dbGet = async (sql, params = []) => {
    const result = await dbRun(sql, params);
    return result.rows[0];
};

const dbAll = async (sql, params = []) => {
    const result = await dbRun(sql, params);
    return result.rows;
};

async function initializeDatabase() {
    try {
        await dbRun(`
            CREATE TABLE IF NOT EXISTS keys (
                id SERIAL PRIMARY KEY,
                key TEXT UNIQUE NOT NULL,
                creator_id TEXT NOT NULL,
                creator_name TEXT NOT NULL,
                creator_username TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                duration TEXT NOT NULL,
                used BOOLEAN DEFAULT false,
                user_roblox_name TEXT,
                user_roblox_id TEXT,
                used_at TIMESTAMP,
                notes TEXT
            );
            
            CREATE TABLE IF NOT EXISTS logs (
                id SERIAL PRIMARY KEY,
                action TEXT NOT NULL,
                key TEXT,
                creator_id TEXT,
                creator_name TEXT,
                user_roblox_name TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                details TEXT
            );
        `);
        console.log('✅ Tabelas PostgreSQL criadas!');
        
        setInterval(cleanupExpiredKeys, 5 * 60 * 1000);
    } catch (error) {
        console.error('❌ Erro ao inicializar banco:', error);
    }
}

async function cleanupExpiredKeys() {
    try {
        const result = await dbRun(
            `DELETE FROM keys WHERE expires_at < NOW() AND used = false RETURNING key`
        );
        if (result.rows.length > 0) {
            console.log(`🗑️ ${result.rows.length} key(s) expirada(s) removida(s)`);
        }
    } catch (error) {
        console.error('❌ Erro ao limpar keys:', error);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

const app = express();
app.use(express.json());

function generateKey() {
    return crypto.randomBytes(8).toString('hex').toUpperCase();
}

async function addLog(action, key, creatorId, creatorName, userRoblox = null, details = null) {
    await dbRun(
        `INSERT INTO logs (action, key, creator_id, creator_name, user_roblox_name, details) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [action, key, creatorId, creatorName, userRoblox, details]
    );
}

// API: Status
app.get('/api/status', async (req, res) => {
    try {
        const result = await dbGet(
            `SELECT COUNT(*) as count FROM keys WHERE used = false AND expires_at > NOW()`
        );
        res.json({ 
            status: 'online',
            totalKeys: parseInt(result.count),
            timestamp: new Date()
        });
    } catch (error) {
        res.json({ status: 'error', message: error.message });
    }
});

// API: Verificar e usar key
app.post('/api/verify', async (req, res) => {
    try {
        const { key, robloxName, robloxId } = req.body;
        
        if (!key) {
            return res.json({ valid: false, message: 'Key não fornecida' });
        }
        
        if (!robloxName || !robloxId) {
            return res.json({ valid: false, message: 'Dados do Roblox não fornecidos' });
        }
        
        const keyData = await dbGet(
            `SELECT * FROM keys WHERE key = $1`,
            [key]
        );
        
        if (!keyData) {
            return res.json({ valid: false, message: 'Key não encontrada' });
        }
        
        if (keyData.used) {
            return res.json({ valid: false, message: 'Key já foi utilizada' });
        }
        
        if (new Date(keyData.expires_at) < new Date()) {
            return res.json({ valid: false, message: 'Key expirada' });
        }
        
        // Atualizar key como usada
        await dbRun(
            `UPDATE keys SET used = true, user_roblox_name = $1, user_roblox_id = $2, used_at = NOW() 
             WHERE key = $3`,
            [robloxName, robloxId, key]
        );
        
        await addLog('VERIFY', key, keyData.creator_id, keyData.creator_name, robloxName, 
                     `Usado por ${robloxName} (ID: ${robloxId})`);
        
        console.log(`✅ Key ${key} usada por ${robloxName} (${robloxId})`);
        
        return res.json({ 
            valid: true, 
            message: 'Key válida! Acesso liberado.',
            data: {
                createdBy: keyData.creator_name,
                duration: keyData.duration,
                createdAt: keyData.created_at
            }
        });
    } catch (error) {
        return res.json({ valid: false, message: error.message });
    }
});

// API: Listar keys com filtros
app.get('/api/keys', async (req, res) => {
    try {
        const { filter } = req.query;
        let query = `SELECT * FROM keys`;
        
        if (filter === 'valid') {
            query += ` WHERE used = false AND expires_at > NOW()`;
        } else if (filter === 'used') {
            query += ` WHERE used = true`;
        } else if (filter === 'expired') {
            query += ` WHERE expires_at < NOW()`;
        }
        
        query += ` ORDER BY created_at DESC LIMIT 200`;
        
        const keys = await dbAll(query);
        res.json(keys);
    } catch (error) {
        res.json({ error: error.message });
    }
});

// API: Estatísticas
app.get('/api/stats', async (req, res) => {
    try {
        const total = await dbGet(`SELECT COUNT(*) as count FROM keys`);
        const used = await dbGet(`SELECT COUNT(*) as count FROM keys WHERE used = true`);
        const valid = await dbGet(
            `SELECT COUNT(*) as count FROM keys WHERE used = false AND expires_at > NOW()`
        );
        const expired = await dbGet(
            `SELECT COUNT(*) as count FROM keys WHERE expires_at < NOW()`
        );
        
        res.json({
            total: parseInt(total.count),
            used: parseInt(used.count),
            valid: parseInt(valid.count),
            expired: parseInt(expired.count)
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

// Discord: Ready
client.once('ready', () => {
    console.log(`✅ Bot online como ${client.user.tag}`);
    
    const commands = [
        new SlashCommandBuilder()
            .setName('getkey')
            .setDescription('Gerar uma nova key')
            .addStringOption(option =>
                option.setName('duracao')
                    .setDescription('Duração da key')
                    .setRequired(true)
                    .addChoices(
                        { name: '1 Hora', value: '1h' },
                        { name: '24 Horas', value: '24h' },
                        { name: '7 Dias', value: '7d' },
                        { name: '30 Dias', value: '30d' },
                        { name: 'Permanente (1 ano)', value: 'perm' }
                    )
            )
            .addStringOption(option =>
                option.setName('notas')
                    .setDescription('Notas sobre a key (opcional)')
                    .setRequired(false)
            ),
        
        new SlashCommandBuilder()
            .setName('minhaskeys')
            .setDescription('Ver suas keys ativas'),
        
        new SlashCommandBuilder()
            .setName('revokekey')
            .setDescription('Revogar uma key')
            .addStringOption(option =>
                option.setName('key')
                    .setDescription('Key para revogar')
                    .setRequired(true)
            ),
        
        new SlashCommandBuilder()
            .setName('checkkey')
            .setDescription('Verificar status de uma key')
            .addStringOption(option =>
                option.setName('key')
                    .setDescription('Key para verificar')
                    .setRequired(true)
            ),
    ];
    
    client.application.commands.set(commands);
});

// Discord: Interações
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    
    const { commandName, user } = interaction;
    
    try {
        if (commandName === 'getkey') {
            const duration = interaction.options.getString('duracao');
            const notes = interaction.options.getString('notas') || '';
            
            let durationMs, durationText;
            
            switch(duration) {
                case '1h': durationMs = 60 * 60 * 1000; durationText = '1 Hora'; break;
                case '24h': durationMs = 24 * 60 * 60 * 1000; durationText = '24 Horas'; break;
                case '7d': durationMs = 7 * 24 * 60 * 60 * 1000; durationText = '7 Dias'; break;
                case '30d': durationMs = 30 * 24 * 60 * 60 * 1000; durationText = '30 Dias'; break;
                case 'perm': durationMs = 365 * 24 * 60 * 60 * 1000; durationText = 'Permanente (1 Ano)'; break;
            }
            
            const key = generateKey();
            const expiresAt = new Date(Date.now() + durationMs);
            
            await dbRun(
                `INSERT INTO keys (key, creator_id, creator_name, creator_username, expires_at, duration, notes) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [key, user.id, user.globalName || user.username, user.username, expiresAt, durationText, notes]
            );
            
            await addLog('CREATE', key, user.id, user.globalName || user.username, null, 
                         `Key gerada: ${durationText}. Notas: ${notes || 'Nenhuma'}`);
            
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('🔐 Nova Key Gerada!')
                .addFields(
                    { name: '🔑 Key', value: `\`${key}\``, inline: false },
                    { name: '⏱️ Duração', value: durationText, inline: true },
                    { name: '📅 Expira em', value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true },
                    { name: '👤 Seu ID', value: `\`${user.id}\``, inline: true }
                )
                .setFooter({ text: 'Guarde sua key em um lugar seguro!' })
                .setTimestamp();
            
            if (notes) {
                embed.addFields({ name: '📝 Notas', value: notes, inline: false });
            }
            
            try {
                await user.send({ embeds: [embed] });
                await interaction.reply({ content: '✅ Key enviada no seu DM!', ephemeral: true });
            } catch {
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
            
            console.log(`🔑 Key gerada: ${key} por ${user.username} (${user.id})`);
        }
        
        if (commandName === 'minhaskeys') {
            const userKeys = await dbAll(
                `SELECT * FROM keys WHERE creator_id = $1 AND expires_at > NOW() ORDER BY created_at DESC`,
                [user.id]
            );
            
            if (userKeys.length === 0) {
                return interaction.reply({ content: '❌ Você não possui keys ativas.', ephemeral: true });
            }
            
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('🔑 Suas Keys Ativas')
                .setDescription(`Total: **${userKeys.length}** key(s) | ID: \`${user.id}\``)
                .setTimestamp();
            
            userKeys.forEach(keyData => {
                const status = keyData.used ? `❌ Usada por ${keyData.user_roblox_name}` : '✅ Válida';
                const expiresDate = new Date(keyData.expires_at);
                
                embed.addFields({
                    name: `\`${keyData.key}\``,
                    value: `Status: ${status}\nDuração: ${keyData.duration}\nExpira: <t:${Math.floor(expiresDate / 1000)}:R>`,
                    inline: false
                });
            });
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        
        if (commandName === 'revokekey') {
            const key = interaction.options.getString('key');
            const keyData = await dbGet(`SELECT * FROM keys WHERE key = $1`, [key]);
            
            if (!keyData) {
                return interaction.reply({ content: '❌ Key não encontrada.', ephemeral: true });
            }
            
            if (keyData.creator_id !== user.id) {
                return interaction.reply({ content: '❌ Esta key não pertence a você.', ephemeral: true });
            }
            
            await dbRun(`DELETE FROM keys WHERE key = $1`, [key]);
            await addLog('REVOKE', key, user.id, user.globalName || user.username, null, 'Key revogada');
            
            await interaction.reply({ content: `✅ Key \`${key}\` revogada!`, ephemeral: true });
            console.log(`🗑️ Key revogada: ${key}`);
        }
        
        if (commandName === 'checkkey') {
            const key = interaction.options.getString('key');
            const keyData = await dbGet(`SELECT * FROM keys WHERE key = $1`, [key]);
            
            if (!keyData) {
                return interaction.reply({ content: '❌ Key não encontrada.', ephemeral: true });
            }
            
            const expired = new Date(keyData.expires_at) < new Date();
            const isValid = !keyData.used && !expired;
            const status = keyData.used ? '❌ Usada' : expired ? '⏰ Expirada' : '✅ Válida';
            
            const createdDate = new Date(keyData.created_at);
            const expiresDate = new Date(keyData.expires_at);
            
            const embed = new EmbedBuilder()
                .setColor(isValid ? '#57F287' : '#ED4245')
                .setTitle('🔍 Status da Key')
                .addFields(
                    { name: '🔑 Key', value: `\`${key}\``, inline: false },
                    { name: '📊 Status', value: status, inline: true },
                    { name: '⏱️ Duração', value: keyData.duration, inline: true },
                    { name: '👤 Criador', value: `${keyData.creator_name} (\`${keyData.creator_id}\`)`, inline: false },
                    { name: '📅 Criada', value: `<t:${Math.floor(createdDate / 1000)}:R>`, inline: true },
                    { name: '⏰ Expira', value: `<t:${Math.floor(expiresDate / 1000)}:R>`, inline: true }
                )
                .setTimestamp();
            
            if (keyData.used) {
                const usedDate = new Date(keyData.used_at);
                embed.addFields({
                    name: '🎮 Usado por (Roblox)',
                    value: `${keyData.user_roblox_name} (\`${keyData.user_roblox_id}\`)\n<t:${Math.floor(usedDate / 1000)}:R>`,
                    inline: false
                });
            }
            
            if (keyData.notes) {
                embed.addFields({ name: '📝 Notas', value: keyData.notes, inline: false });
            }
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    } catch (error) {
        console.error('❌ Erro:', error);
        await interaction.reply({ content: '❌ Erro ao processar comando!', ephemeral: true });
    }
});

initializeDatabase().then(() => {
    client.login(config.token);
    
    app.listen(config.port, () => {
        console.log(`🌐 API rodando na porta ${config.port}`);
        console.log(`📡 Dashboard: http://localhost:${config.port}`);
    });
});
