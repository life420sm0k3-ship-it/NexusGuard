require('dotenv').config();
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const { Client, GatewayIntentBits, Partials, REST, Routes, Events, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db, getSettings, setSettings, audit } = require('./database');
const { commands } = require('./commands');

const required = ['DISCORD_TOKEN','DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_REDIRECT_URI','DASHBOARD_URL','OWNER_DISCORD_ID','SESSION_SECRET'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn(`[NexusGuard] Missing environment variables: ${missing.join(', ')}. Bot or OAuth features will not fully start until configured.`);
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) console.warn('[NexusGuard] SESSION_SECRET should be at least 32 characters.');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildModeration], partials: [Partials.Channel, Partials.Message, Partials.User] });
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"], fontSrc:["'self'","https://fonts.gstatic.com"], imgSrc:["'self'","data:","https://cdn.discordapp.com"], scriptSrc:["'self'","'unsafe-inline'"] }}}));
app.use(express.json({ limit:'100kb' }));
app.use(express.urlencoded({ extended:false, limit:'20kb' }));
app.use(session({ name:'nexusguard.sid', secret:process.env.SESSION_SECRET || 'development-only-change-this-session-secret', resave:false, saveUninitialized:false, store:new SQLiteStore({ db:'sessions.sqlite', dir:path.resolve('./data') }), cookie:{ httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:7*24*60*60*1000 } }));
app.use(express.static(path.join(__dirname,'dashboard','public'), { extensions:['html'] }));
app.use('/auth',rateLimit({windowMs:15*60*1000,limit:40,standardHeaders:true,legacyHeaders:false}));
app.use('/api',rateLimit({windowMs:60*1000,limit:120,standardHeaders:true,legacyHeaders:false}));
const base = () => (process.env.DASHBOARD_URL || '').replace(/\/$/,'');
const isOwner = req => !!req.session.user && req.session.user.id === process.env.OWNER_DISCORD_ID;
const requireLogin = (req,res,next) => req.session.user ? next() : res.status(401).json({error:'Sign in with Discord to continue.'});
const requireOwner = (req,res,next) => isOwner(req) ? next() : res.status(403).json({error:'Global owner access required.'});
async function exchangeCode(code) {
 const body = new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:process.env.DISCORD_REDIRECT_URI});
 const r=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 const data=await r.json(); if(!r.ok) throw new Error(data.error_description||data.error||'OAuth token exchange failed'); return data;
}
async function discordGet(url,token) { const r=await fetch(`https://discord.com/api${url}`,{headers:{Authorization:`Bearer ${token}`}}); if(!r.ok) throw new Error(`Discord API request failed (${r.status})`); return r.json(); }
async function ensureAccessToken(req) { if (req.session.tokenExpiresAt && Date.now() < req.session.tokenExpiresAt - 120000) return req.session.accessToken; if (!req.session.refreshToken) throw new Error('Discord session expired; sign in again.'); const body=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:req.session.refreshToken}); const r=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}); const data=await r.json(); if(!r.ok) throw new Error('Discord session expired; sign in again.'); req.session.accessToken=data.access_token; req.session.refreshToken=data.refresh_token||req.session.refreshToken; req.session.tokenExpiresAt=Date.now()+data.expires_in*1000; return req.session.accessToken; }
function canManageGuild(guild) { return guild.owner || (Number(BigInt(guild.permissions) & BigInt(PermissionFlagsBits.ManageGuild)) !== 0) || (Number(BigInt(guild.permissions) & BigInt(PermissionFlagsBits.Administrator)) !== 0); }
async function allowedGuilds(req) {
 if (isOwner(req)) return client.guilds.cache.map(g=>({id:g.id,name:g.name,icon:g.iconURL({size:128}),owner:g.ownerId===req.session.user.id,botPresent:true}));
 const token=await ensureAccessToken(req); const guilds=await discordGet('/users/@me/guilds',token);
 return guilds.filter(g=>canManageGuild(g) && client.guilds.cache.has(g.id)).map(g=>({id:g.id,name:g.name,icon:g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`:null,owner:g.owner,botPresent:true}));
}
function ownsGuildAccess(req,guildId,guilds) { return isOwner(req) || guilds.some(g=>g.id===guildId && canManageGuild(g)); }

app.get('/health',(req,res)=>res.json({ok:true,service:'NexusGuard',botReady:client.isReady(),uptime:Math.floor(process.uptime()),guilds:client.guilds.cache.size,commands:commands.length,now:new Date().toISOString()}));
app.get('/auth/login',(req,res)=>{const state=require('node:crypto').randomBytes(24).toString('hex');req.session.oauthState=state;const u=new URL('https://discord.com/oauth2/authorize');u.searchParams.set('client_id',process.env.DISCORD_CLIENT_ID||'');u.searchParams.set('redirect_uri',process.env.DISCORD_REDIRECT_URI||`${base()}/auth/callback`);u.searchParams.set('response_type','code');u.searchParams.set('scope','identify guilds');u.searchParams.set('state',state);res.redirect(u.toString());});
app.get('/auth/callback',async(req,res)=>{try{if(req.query.error) return res.redirect('/?loginError='+encodeURIComponent(String(req.query.error)));if(!req.query.code||!req.query.state||req.query.state!==req.session.oauthState)return res.redirect('/?loginError=invalid_state');delete req.session.oauthState;const token=await exchangeCode(String(req.query.code));const user=await discordGet('/users/@me',token.access_token);req.session.user={id:user.id,username:user.username,global_name:user.global_name||user.username,avatar:user.avatar,discriminator:user.discriminator};req.session.accessToken=token.access_token;req.session.refreshToken=token.refresh_token;req.session.tokenExpiresAt=Date.now()+token.expires_in*1000;req.session.save(err=>{if(err)return res.redirect('/?loginError=session_save_failed');res.redirect('/dashboard');});}catch(e){console.error('[OAuth callback]',e.message);res.redirect('/?loginError=oauth_failed');}});
app.post('/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('nexusguard.sid');res.json({ok:true});}));
app.get('/api/me',(req,res)=>{if(!req.session.user)return res.json({authenticated:false});res.json({authenticated:true,user:{...req.session.user,avatarUrl:req.session.user.avatar?`https://cdn.discordapp.com/avatars/${req.session.user.id}/${req.session.user.avatar}.png?size=128`:null},owner:isOwner(req),botReady:client.isReady(),clientId:process.env.DISCORD_CLIENT_ID||''});});
app.get('/api/guilds',requireLogin,async(req,res)=>{try{res.json({guilds:await allowedGuilds(req),owner:isOwner(req)});}catch(e){console.error('guilds',e.message);res.status(502).json({error:'Could not load Discord servers. Please sign in again.'});}});
app.get('/api/guild/:guildId',requireLogin,async(req,res)=>{try{const guilds=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,guilds))return res.status(403).json({error:'You do not have permission to manage this server.'});const g=client.guilds.cache.get(req.params.guildId);if(!g&&!isOwner(req))return res.status(409).json({error:'NexusGuard is not in this server yet. Invite the bot first.'});const s=getSettings(req.params.guildId);const logs=db.prepare('SELECT id,actor_id,action,target_id,details,created_at FROM audit_log WHERE guild_id=? ORDER BY id DESC LIMIT 25').all(req.params.guildId).map(x=>({...x,details:safeParse(x.details)}));const counts={members:g?.memberCount??null,channels:g?.channels.cache.size??null,roles:g?.roles.cache.size??null,warnings:db.prepare('SELECT COUNT(*) n FROM warnings WHERE guild_id=?').get(req.params.guildId).n,tickets:db.prepare("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'").get(req.params.guildId).n};res.json({guild:g?{id:g.id,name:g.name,icon:g.iconURL(),memberCount:g.memberCount}: {id:req.params.guildId,name:'Unknown server'},settings:s,counts,logs});}catch(e){console.error('guild details',e);res.status(500).json({error:'Could not load server settings.'});}});
function safeParse(v){try{return JSON.parse(v)}catch{return {}}}
const SERVER_TEMPLATES = {
 gaming:{welcomeEnabled:true,leaveEnabled:true,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,levelEnabled:true,currencyName:'XP Coins',starboardThreshold:3,maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10},
 minecraft:{welcomeEnabled:true,leaveEnabled:false,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,verificationEnabled:true,levelEnabled:true,currencyName:'Emeralds',starboardThreshold:3,maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10},
 community:{welcomeEnabled:true,leaveEnabled:true,automodEnabled:true,antiSpam:true,antiInvite:false,antiMassMention:true,antiRaid:true,levelEnabled:true,currencyName:'Community Coins',starboardThreshold:3,maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10},
 creator:{welcomeEnabled:true,leaveEnabled:false,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,levelEnabled:true,currencyName:'Fan Points',starboardThreshold:5,maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10},
 business:{welcomeEnabled:true,leaveEnabled:false,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,levelEnabled:false,currencyName:'Credits',starboardThreshold:5,maxWarningsBeforeTimeout:2,defaultTimeoutMinutes:15},
 roleplay:{welcomeEnabled:true,leaveEnabled:true,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,levelEnabled:true,currencyName:'Gold',starboardThreshold:3,maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10},
 support:{welcomeEnabled:true,leaveEnabled:false,automodEnabled:true,antiSpam:true,antiInvite:true,antiMassMention:true,antiRaid:true,levelEnabled:false,currencyName:'Points',maxWarningsBeforeTimeout:2,defaultTimeoutMinutes:15},
 custom:{welcomeEnabled:false,leaveEnabled:false,automodEnabled:true,antiSpam:true,antiInvite:false,antiMassMention:true,antiRaid:true,levelEnabled:true,currencyName:'Nexus Credits',maxWarningsBeforeTimeout:3,defaultTimeoutMinutes:10}
};
app.post('/api/guild/:guildId/setup',requireLogin,async(req,res)=>{try{const guilds=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,guilds))return res.status(403).json({error:'You do not have permission to configure this server.'});const g=client.guilds.cache.get(req.params.guildId);if(!g)return res.status(409).json({error:'NexusGuard must be installed in this server before setup.'});const type=String(req.body?.serverType||'custom');if(!Object.prototype.hasOwnProperty.call(SERVER_TEMPLATES,type))return res.status(400).json({error:'Choose a valid server type.'});const applyTemplate=req.body?.applyTemplate!==false;const existing=getSettings(g.id);const patch={serverType:type,setupComplete:true,setupCompletedAt:new Date().toISOString()};if(applyTemplate){for(const [key,value] of Object.entries(SERVER_TEMPLATES[type]))if(existing[key]===undefined||existing[key]===null)patch[key]=value;/* The initial template should set defaults, but never overwrite explicit prior choices. */if(!existing.setupComplete)Object.assign(patch,SERVER_TEMPLATES[type]);}const settings=setSettings(g.id,patch);audit(g.id,req.session.user.id,'server_setup_completed',null,{serverType:type,templateApplied:applyTemplate});res.json({ok:true,serverType:type,settings,templateApplied:applyTemplate});}catch(e){console.error('server setup',e);res.status(500).json({error:'Could not finish server setup.'});}});
app.patch('/api/guild/:guildId/settings',requireLogin,async(req,res)=>{try{const guilds=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,guilds))return res.status(403).json({error:'You do not have permission to manage this server.'});const patch=req.body||{};const allowed=['serverType','setupComplete','setupCompletedAt','accent','welcomeEnabled','welcomeChannelId','welcomeMessage','leaveEnabled','leaveChannelId','logChannelId','automodEnabled','antiSpam','antiInvite','antiMassMention','antiRaid','mentionLimit','ticketCategoryId','ticketStaffRoleId','ticketLogChannelId','levelEnabled','xpPerMessage','xpCooldownSeconds','currencyName','slowmodeDefault','verificationEnabled','verificationRoleId','verificationChannelId','suggestionsChannelId','announcementsChannelId','starboardChannelId','starboardThreshold','maxWarningsBeforeTimeout','defaultTimeoutMinutes','raidJoinThreshold','raidWindowSeconds','serverNotes'];const clean={};for(const k of allowed)if(Object.prototype.hasOwnProperty.call(patch,k)){const v=patch[k];if(typeof v==='string')clean[k]=v.slice(0,k==='welcomeMessage'?1000:500);else if(typeof v==='boolean')clean[k]=v;else if(typeof v==='number'&&Number.isFinite(v))clean[k]=Math.max(0,Math.min(100000,v));}const s=setSettings(req.params.guildId,clean);audit(req.params.guildId,req.session.user.id,'dashboard_settings_update',null,{keys:Object.keys(clean)});res.json({ok:true,settings:s});}catch(e){console.error('settings update',e);res.status(500).json({error:'Could not save settings.'});}});
app.get('/api/guild/:guildId/channels',requireLogin,async(req,res)=>{try{const gs=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,gs))return res.status(403).json({error:'Forbidden'});const g=client.guilds.cache.get(req.params.guildId);if(!g)return res.status(409).json({error:'Bot is not in this server.'});res.json({channels:g.channels.cache.filter(c=>c.isTextBased()||c.type===4).map(c=>({id:c.id,name:c.name,type:c.type,parentId:c.parentId})).sort((a,b)=>a.name.localeCompare(b.name))});}catch{res.status(500).json({error:'Could not load channels.'});}});
app.get('/api/guild/:guildId/roles',requireLogin,async(req,res)=>{try{const gs=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,gs))return res.status(403).json({error:'Forbidden'});const g=client.guilds.cache.get(req.params.guildId);if(!g)return res.status(409).json({error:'Bot is not in this server.'});res.json({roles:g.roles.cache.filter(r=>r.id!==g.id).map(r=>({id:r.id,name:r.name,color:r.hexColor,position:r.position,managed:r.managed})).sort((a,b)=>b.position-a.position)});}catch{res.status(500).json({error:'Could not load roles.'});}});
app.get('/api/guild/:guildId/analytics',requireLogin,async(req,res)=>{try{const gs=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,gs))return res.status(403).json({error:'Forbidden'});const id=req.params.guildId;res.json({warnings:db.prepare('SELECT COUNT(*) n FROM warnings WHERE guild_id=?').get(id).n,cases:db.prepare('SELECT COUNT(*) n FROM cases WHERE guild_id=?').get(id).n,openTickets:db.prepare("SELECT COUNT(*) n FROM tickets WHERE guild_id=? AND status='open'").get(id).n,suggestions:db.prepare('SELECT COUNT(*) n FROM suggestions WHERE guild_id=?').get(id).n,levels:db.prepare('SELECT COUNT(*) n FROM user_xp WHERE guild_id=?').get(id).n,actions:db.prepare('SELECT action,COUNT(*) n FROM audit_log WHERE guild_id=? GROUP BY action ORDER BY n DESC LIMIT 8').all(id)});}catch{res.status(500).json({error:'Could not load analytics.'});}});
// Additional dashboard management APIs. Every guild-scoped route re-checks Discord permissions.
async function dashboardGuild(req){const gs=await allowedGuilds(req);if(!ownsGuildAccess(req,req.params.guildId,gs))throw Object.assign(new Error('You do not have permission to manage this server.'),{status:403});const g=client.guilds.cache.get(req.params.guildId);if(!g)throw Object.assign(new Error('NexusGuard is not in this server.'),{status:409});return g;}
app.post('/api/guild/:guildId/member-action',requireLogin,async(req,res)=>{try{const g=await dashboardGuild(req);const {userId,action,reason='Action issued from NexusGuard dashboard',minutes=10}=req.body||{};if(!/^\d{17,20}$/.test(String(userId||'')))return res.status(400).json({error:'Enter a valid Discord user ID.'});if(!['timeout','kick','ban','unban'].includes(action))return res.status(400).json({error:'Unsupported moderation action.'});const me=g.members.me;if(!me)return res.status(409).json({error:'Could not resolve NexusGuard bot member.'});const need={timeout:PermissionFlagsBits.ModerateMembers,kick:PermissionFlagsBits.KickMembers,ban:PermissionFlagsBits.BanMembers,unban:PermissionFlagsBits.BanMembers}[action];if(!me.permissions.has(need))return res.status(403).json({error:`NexusGuard needs the ${action==='timeout'?'Moderate Members':action==='kick'?'Kick Members':'Ban Members'} permission.`});const cleanReason=String(reason||'No reason provided').slice(0,450);if(action==='unban'){await g.members.unban(String(userId),cleanReason);audit(g.id,req.session.user.id,'dashboard_unban',String(userId),{reason:cleanReason});return res.json({ok:true,message:'User unbanned.'});}const target=await g.members.fetch(String(userId)).catch(()=>null);if(!target)return res.status(404).json({error:'Member was not found in this server.'});if(target.id===g.ownerId)return res.status(403).json({error:'The server owner cannot be moderated by this dashboard.'});if(target.id===me.id)return res.status(400).json({error:'NexusGuard cannot moderate itself.'});if(target.roles.highest.position>=me.roles.highest.position)return res.status(403).json({error:'NexusGuard role must be above the target member’s highest role.'});if(action==='timeout'){const duration=Math.max(1,Math.min(40320,Number(minutes)||10));await target.timeout(duration*60000,cleanReason);}else if(action==='kick')await target.kick(cleanReason);else if(action==='ban')await target.ban({reason:cleanReason,deleteMessageSeconds:0});audit(g.id,req.session.user.id,`dashboard_${action}`,String(userId),{reason:cleanReason,minutes:action==='timeout'?Math.max(1,Math.min(40320,Number(minutes)||10)):undefined});res.json({ok:true,message:action==='timeout'?`Member timed out for ${Math.max(1,Math.min(40320,Number(minutes)||10))} minutes.`:`Member ${action}ed successfully.`});}catch(e){console.error('dashboard moderation',e);res.status(e.status||500).json({error:e.message||'Moderation action failed. Check the bot permissions and role hierarchy.'});}});
app.post('/api/guild/:guildId/channels',requireLogin,async(req,res)=>{try{const g=await dashboardGuild(req);if(!g.members.me?.permissions.has(PermissionFlagsBits.ManageChannels))return res.status(403).json({error:'NexusGuard needs Manage Channels permission.'});const name=String(req.body?.name||'').trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,90);const type=String(req.body?.type||'text');if(name.length<2)return res.status(400).json({error:'Channel name must contain at least two valid characters.'});const types={text:0,voice:2,category:4,announcement:5};if(!(type in types))return res.status(400).json({error:'Choose a valid channel type.'});const channel=await g.channels.create({name,type:types[type],reason:`Created from NexusGuard dashboard by ${req.session.user.id}`});audit(g.id,req.session.user.id,'dashboard_channel_created',channel.id,{name:channel.name,type});res.json({ok:true,channel:{id:channel.id,name:channel.name,type:channel.type}});}catch(e){console.error('dashboard channel create',e);res.status(500).json({error:e.message||'Could not create channel. Check bot permissions.'});}});
app.get('/api/guild/:guildId/warnings',requireLogin,async(req,res)=>{try{await dashboardGuild(req);const rows=db.prepare('SELECT id,user_id,moderator_id,reason,created_at FROM warnings WHERE guild_id=? ORDER BY id DESC LIMIT 100').all(req.params.guildId);res.json({warnings:rows});}catch(e){res.status(e.status||500).json({error:e.message||'Could not load warnings.'});}});
app.get('/api/guild/:guildId/tickets',requireLogin,async(req,res)=>{try{await dashboardGuild(req);const rows=db.prepare('SELECT id,user_id,channel_id,subject,status,created_at,closed_at FROM tickets WHERE guild_id=? ORDER BY id DESC LIMIT 100').all(req.params.guildId);res.json({tickets:rows});}catch(e){res.status(e.status||500).json({error:e.message||'Could not load tickets.'});}});
app.get('/api/guild/:guildId/scheduled',requireLogin,async(req,res)=>{try{await dashboardGuild(req);const rows=db.prepare('SELECT id,channel_id,text,due_at,sent FROM scheduled_messages WHERE guild_id=? ORDER BY id DESC LIMIT 100').all(req.params.guildId);res.json({messages:rows});}catch(e){res.status(e.status||500).json({error:e.message||'Could not load scheduled messages.'});}});
app.post('/api/guild/:guildId/scheduled',requireLogin,async(req,res)=>{try{const g=await dashboardGuild(req);const {channelId,text:message,dueAt}=req.body||{};if(typeof message!=='string'||!message.trim()||message.length>1900)return res.status(400).json({error:'Message must be 1–1900 characters.'});const due=Number(dueAt);if(!Number.isFinite(due)||due<Date.now()+30000||due>Date.now()+90*86400000)return res.status(400).json({error:'Schedule time must be between 30 seconds and 90 days from now.'});const ch=g.channels.cache.get(String(channelId||''));if(!ch?.isTextBased())return res.status(400).json({error:'Choose a text channel in this server.'});const r=db.prepare('INSERT INTO scheduled_messages(guild_id,channel_id,text,due_at) VALUES(?,?,?,?)').run(g.id,ch.id,message.trim(),due);audit(g.id,req.session.user.id,'scheduled_message_created',ch.id,{scheduleId:r.lastInsertRowid,dueAt:due});res.json({ok:true,id:r.lastInsertRowid});}catch(e){res.status(e.status||500).json({error:e.message||'Could not schedule message.'});}});
app.delete('/api/guild/:guildId/scheduled/:id',requireLogin,async(req,res)=>{try{const g=await dashboardGuild(req);const r=db.prepare('DELETE FROM scheduled_messages WHERE id=? AND guild_id=? AND sent=0').run(Number(req.params.id),g.id);if(!r.changes)return res.status(404).json({error:'Pending scheduled message not found.'});audit(g.id,req.session.user.id,'scheduled_message_cancelled',req.params.id);res.json({ok:true});}catch(e){res.status(e.status||500).json({error:e.message||'Could not cancel message.'});}});
app.get('/api/guild/:guildId/export',requireLogin,async(req,res)=>{try{await dashboardGuild(req);const id=req.params.guildId;const data={exportedAt:new Date().toISOString(),guildId:id,settings:getSettings(id),warnings:db.prepare('SELECT * FROM warnings WHERE guild_id=? ORDER BY id DESC LIMIT 5000').all(id),cases:db.prepare('SELECT * FROM cases WHERE guild_id=? ORDER BY id DESC LIMIT 5000').all(id),tickets:db.prepare('SELECT * FROM tickets WHERE guild_id=? ORDER BY id DESC LIMIT 5000').all(id),audit:db.prepare('SELECT * FROM audit_log WHERE guild_id=? ORDER BY id DESC LIMIT 5000').all(id),suggestions:db.prepare('SELECT * FROM suggestions WHERE guild_id=? ORDER BY id DESC LIMIT 5000').all(id)};audit(id,req.session.user.id,'data_export');res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition',`attachment; filename="nexusguard-${id}-backup.json"`);res.send(JSON.stringify(data,null,2));}catch(e){res.status(e.status||500).json({error:e.message||'Export failed.'});}});
app.get('/api/owner/commands',requireLogin,requireOwner,(req,res)=>res.json({commands:commands.map(c=>({name:c.data.name,description:c.data.description,category:c.category}))}));
app.post('/api/owner/commands/sync',requireLogin,requireOwner,async(req,res)=>{try{const result=await syncSlashCommands();res.json({ok:true,...result,message:result.scope==='guild'?`Synced ${result.count} slash commands to the selected test server. They should appear shortly.`:`Synced ${result.count} global slash commands. Discord may take up to an hour to show global updates; set DEV_GUILD_ID in Render for instant updates in a test server.`});}catch(e){captureError('command-registration-manual',e);res.status(502).json({error:`Slash-command sync failed: ${String(e?.message||e).slice(0,350)}`});}});
app.get('/api/owner/database-stats',requireLogin,requireOwner,(req,res)=>{const tables=['guild_settings','audit_log','warnings','tickets','cases','user_xp','reminders','scheduled_messages','custom_commands','giveaways','suggestions','owner_hourly_report_runs'];const counts={};for(const t of tables){try{counts[t]=db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n}catch{counts[t]=0}}res.json({counts,uptime:Math.floor(process.uptime()),memory:process.memoryUsage(),node:process.version,platform:process.platform});});
app.get('/api/owner/overview',requireLogin,requireOwner,async(req,res)=>{res.json({uptime:Math.floor(process.uptime()),botReady:client.isReady(),guildCount:client.guilds.cache.size,userCount:client.guilds.cache.reduce((n,g)=>n+(g.memberCount||0),0),commandCount:commands.length,warningCount:db.prepare('SELECT COUNT(*) n FROM warnings').get().n,ticketCount:db.prepare('SELECT COUNT(*) n FROM tickets').get().n,dbSize:'managed by SQLite',guilds:client.guilds.cache.map(g=>({id:g.id,name:g.name,members:g.memberCount,ownerId:g.ownerId}))});});
app.post('/api/owner/announce',requireLogin,requireOwner,async(req,res)=>{const {guildId,channelId,message}=req.body||{};if(!message||typeof message!=='string'||message.length>1800)return res.status(400).json({error:'Provide an announcement under 1800 characters.'});try{const g=client.guilds.cache.get(guildId);const c=g?.channels.cache.get(channelId);if(!c?.isTextBased())return res.status(400).json({error:'Server or text channel not found.'});await c.send({embeds:[new EmbedBuilder().setColor(0x8b5cf6).setTitle('NexusGuard Owner Announcement').setDescription(message).setTimestamp()]});audit(guildId,req.session.user.id,'owner_announcement',channelId,{message:message.slice(0,200)});res.json({ok:true});}catch(e){res.status(500).json({error:'Announcement failed. Check bot channel permissions.'});}});
app.get('/api/owner/errors',requireLogin,requireOwner,(req,res)=>res.json({recent:recentErrors.slice(-30)}));
const recentErrors=[];
function captureError(area,error){const detail=error?.rawError?.message?`${error.message} — ${error.rawError.message}`:String(error?.message||error);const item={at:new Date().toISOString(),area,message:detail.slice(0,700),code:error?.code??null,status:error?.status??error?.statusCode??null};recentErrors.push(item);if(recentErrors.length>100)recentErrors.shift();console.error(`[${area}]`,item.message,error?.code?`(code ${error.code})`:'',error?.status?`(HTTP ${error.status})`:'')}

async function syncSlashCommands(){
 if(!client.isReady())throw new Error('The Discord bot is not ready yet. Check Render logs and DISCORD_TOKEN.');
 if(!process.env.DISCORD_TOKEN)throw new Error('DISCORD_TOKEN is missing in Render environment variables.');
 const liveApplicationId=client.application?.id;
 const configuredApplicationId=(process.env.DISCORD_CLIENT_ID||'').trim();
 if(!liveApplicationId)throw new Error('Discord has not returned the bot application ID yet. Wait for the bot to finish connecting.');
 if(configuredApplicationId && configuredApplicationId!==liveApplicationId){
  throw new Error(`DISCORD_CLIENT_ID (${configuredApplicationId}) does not match the application belonging to DISCORD_TOKEN (${liveApplicationId}). Set both variables to the same Discord application.`);
 }
 const applicationId=liveApplicationId;
 const guildId=(process.env.DEV_GUILD_ID||'').trim();
 if(guildId&&!/^\d{17,20}$/.test(guildId))throw new Error('DEV_GUILD_ID must be a numeric Discord server ID, or be left blank for global commands.');
 if(guildId&&!client.guilds.cache.has(guildId))throw new Error(`The bot is not currently in DEV_GUILD_ID ${guildId}. Invite this bot to that server or clear DEV_GUILD_ID to register globally.`);
 let body;
 try { body=commands.map(c=>c.data.toJSON()); }
 catch(e) { throw new Error(`A slash command has an invalid Discord definition: ${e.message}`); }
 const names=body.map(c=>c.name);
 const duplicates=names.filter((name,index)=>names.indexOf(name)!==index);
 if(duplicates.length)throw new Error(`Duplicate slash command name(s): ${[...new Set(duplicates)].join(', ')}.`);
 const invalid=body.filter(c=>!/^[-a-z0-9]{1,32}$/.test(c.name)||!c.description||c.description.length>100);
 if(invalid.length)throw new Error(`Invalid command definition(s): ${invalid.map(c=>c.name).join(', ')}.`);
 if(body.length>100)throw new Error(`Discord allows at most 100 chat-input commands per scope; this build contains ${body.length}.`);
 const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
 const route=guildId?Routes.applicationGuildCommands(applicationId,guildId):Routes.applicationCommands(applicationId);
 let registered, lastError;
 for(let attempt=1;attempt<=3;attempt++){
  try { registered=await rest.put(route,{body}); lastError=null; break; }
  catch(e){
   lastError=e;
   const retryable=Number(e?.status)>=500 || Number(e?.status)===429 || e?.code==='ECONNRESET' || e?.code==='ETIMEDOUT';
   console.error(`[NexusGuard] Slash-command sync attempt ${attempt}/3 failed: ${e?.message||e} (status ${e?.status||'n/a'}, code ${e?.code||'n/a'})`);
   if(!retryable||attempt===3)break;
   await new Promise(resolve=>setTimeout(resolve,attempt*1500));
  }
 }
 if(lastError){
  const status=lastError.status?` HTTP ${lastError.status}.`:'';
  const hint=lastError.status===401?' Check DISCORD_TOKEN.':lastError.status===403?' Check the bot token and application access.':lastError.status===404?' Check DISCORD_CLIENT_ID and DEV_GUILD_ID.':'';
  throw new Error(`Discord rejected slash-command registration.${status}${hint} ${String(lastError.message||lastError).slice(0,250)}`);
 }
 const count=Array.isArray(registered)?registered.length:body.length;
 console.log(`[NexusGuard] Successfully synced ${count}/${body.length} slash commands to ${guildId?`guild ${guildId}`:'global scope'} for application ${applicationId}.`);
 console.log(`[NexusGuard] Registered commands: ${names.join(', ')}`);
 return {count,scope:guildId?'guild':'global',guildId:guildId||null,applicationId,commandNames:names};
}

// Private hourly health reports are delivered only to OWNER_DISCORD_ID.
// SQLite's primary key prevents duplicate reports for the same hour if more
// than one app instance happens to run against the same persistent database.
async function sendOwnerHourlyReport({manual=false}={}) {
 if (process.env.HOURLY_OWNER_REPORTS === 'false') return { skipped:true, reason:'disabled' };
 if (!client.isReady()) return { skipped:true, reason:'bot_not_ready' };
 const ownerId=process.env.OWNER_DISCORD_ID;
 if (!ownerId || !/^\d{15,22}$/.test(ownerId)) {
  captureError('hourly-report','OWNER_DISCORD_ID is missing or invalid; cannot send private report.');
  return { skipped:true, reason:'owner_id_missing' };
 }
 const hourKey=new Date().toISOString().slice(0,13); // UTC hour, e.g. 2026-10-24T21
 if (!manual) {
  const claim=db.prepare('INSERT OR IGNORE INTO owner_hourly_report_runs(hour_key) VALUES(?)').run(hourKey);
  if (!claim.changes) return { skipped:true, reason:'already_sent_or_claimed' };
 }
 try {
  const owner=await client.users.fetch(ownerId);
  const guildCount=client.guilds.cache.size;
  const memberCount=client.guilds.cache.reduce((n,g)=>n+(g.memberCount||0),0);
  const warningCount=db.prepare('SELECT COUNT(*) n FROM warnings').get().n;
  const openTickets=db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='open'").get().n;
  const auditLastHour=db.prepare("SELECT COUNT(*) n FROM audit_log WHERE created_at >= datetime('now','-1 hour')").get().n;
  const errorsLastHour=recentErrors.filter(e=>Date.now()-Date.parse(e.at)<60*60*1000);
  const uptimeSeconds=Math.floor(process.uptime());
  const uptime=`${Math.floor(uptimeSeconds/86400)}d ${Math.floor((uptimeSeconds%86400)/3600)}h ${Math.floor((uptimeSeconds%3600)/60)}m`;
  const embed=new EmbedBuilder()
   .setColor(client.isReady()?0x20c997:0xed4245)
   .setTitle('NexusGuard · Hourly Private Status')
   .setDescription(`Automated ${manual?'test':'hourly'} report for <@${ownerId}>.`)
   .addFields(
    {name:'Bot status',value:client.isReady()?'🟢 Online':'🔴 Offline',inline:true},
    {name:'Uptime',value:uptime,inline:true},
    {name:'Connected servers',value:String(guildCount),inline:true},
    {name:'Approx. combined members',value:String(memberCount),inline:true},
    {name:'Total warnings recorded',value:String(warningCount),inline:true},
    {name:'Open tickets',value:String(openTickets),inline:true},
    {name:'Audit actions (last hour)',value:String(auditLastHour),inline:true},
    {name:'Runtime errors (last hour)',value:errorsLastHour.length?errorsLastHour.slice(-3).map(e=>`• ${e.area}: ${e.message}`).join('\n').slice(0,1000):'None recorded',inline:false}
   )
   .setFooter({text:'NexusGuard owner-only report · Times shown in UTC'})
   .setTimestamp(new Date());
  await owner.send({embeds:[embed]});
  console.log(`[NexusGuard] ${manual?'Test':'Hourly'} private status report sent to owner ${ownerId}.`);
  return {sent:true};
 } catch(e) {
  if (!manual) db.prepare('DELETE FROM owner_hourly_report_runs WHERE hour_key=?').run(hourKey);
  captureError('hourly-owner-report',e);
  return {sent:false,reason:String(e?.message||e)};
 }
}
app.post('/api/owner/report-test',requireLogin,requireOwner,async(req,res)=>{
 const result=await sendOwnerHourlyReport({manual:true});
 if(result.sent)return res.json({ok:true,message:'Test report sent to your Discord DMs.'});
 res.status(503).json({error:result.reason==='bot_not_ready'?'The bot is not online yet.':result.reason==='owner_id_missing'?'Set OWNER_DISCORD_ID to your numeric Discord user ID in Render.':'Could not DM you. Make sure your Discord account allows DMs from this bot, then check Render logs.'});
});
app.get('/dashboard',(req,res)=>res.sendFile(path.join(__dirname,'dashboard','public','dashboard.html')));
app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/auth/'))return next();res.sendFile(path.join(__dirname,'dashboard','public','index.html'));});
app.use((err,req,res,next)=>{captureError('http',err);if(res.headersSent)return next(err);res.status(500).json({error:'Unexpected server error.'});});


async function processBackgroundTasks(){
 const now=Date.now();
 // Claim due reminders before delivery to reduce duplicate sends on restarts/multiple workers.
 const dueReminders=db.prepare('SELECT id,user_id,channel_id,text,due_at FROM reminders WHERE sent=0 AND due_at<=? ORDER BY due_at LIMIT 50').all(now);
 for(const r of dueReminders){const claimed=db.prepare('UPDATE reminders SET sent=1 WHERE id=? AND sent=0').run(r.id);if(!claimed.changes)continue;try{const message=`⏰ Reminder: ${r.text}`;if(r.channel_id){const ch=await client.channels.fetch(r.channel_id).catch(()=>null);if(ch?.isTextBased())await ch.send(`<@${r.user_id}> ${message}`);else await (await client.users.fetch(r.user_id)).send(message);}else await (await client.users.fetch(r.user_id)).send(message);}catch(e){captureError('reminder-delivery',e);}}
 const dueMessages=db.prepare('SELECT id,guild_id,channel_id,text FROM scheduled_messages WHERE sent=0 AND due_at<=? ORDER BY due_at LIMIT 50').all(now);
 for(const r of dueMessages){const claimed=db.prepare('UPDATE scheduled_messages SET sent=1 WHERE id=? AND sent=0').run(r.id);if(!claimed.changes)continue;try{const ch=await client.channels.fetch(r.channel_id).catch(()=>null);if(ch?.isTextBased())await ch.send(r.text.slice(0,1900));else captureError('scheduled-message',`Channel unavailable for scheduled message #${r.id}`);}catch(e){captureError('scheduled-message',e);}}
 const dueGiveaways=db.prepare('SELECT id,guild_id,channel_id,message_id,prize,winner_count FROM giveaways WHERE ended=0 AND ends_at<=? ORDER BY ends_at LIMIT 20').all(now);
 for(const g of dueGiveaways){const claimed=db.prepare('UPDATE giveaways SET ended=1 WHERE id=? AND ended=0').run(g.id);if(!claimed.changes)continue;try{const ch=await client.channels.fetch(g.channel_id).catch(()=>null);const msg=ch?.isTextBased()&&g.message_id?await ch.messages.fetch(g.message_id).catch(()=>null):null;const reaction=msg?.reactions.cache.get('🎉');const users=reaction?await reaction.users.fetch():null;const entrants=users?[...users.values()].filter(u=>!u.bot):[];const winners=[];while(entrants.length&&winners.length<Math.max(1,Math.min(10,g.winner_count||1))){winners.push(entrants.splice(Math.floor(Math.random()*entrants.length),1)[0]);}if(ch?.isTextBased())await ch.send(winners.length?`🎉 Giveaway **${g.prize}** has ended! Winner(s): ${winners.map(u=>`<@${u.id}>`).join(', ')}. Congratulations!`:`🎉 Giveaway **${g.prize}** ended with no valid entrants.`);}catch(e){captureError('giveaway-closeout',e);}}
}

client.once(Events.ClientReady,async()=>{
 console.log(`[NexusGuard] Logged in as ${client.user.tag}; ${client.guilds.cache.size} server(s).`);
 try { await processBackgroundTasks(); } catch(e) { captureError('background-worker-start',e); }
 const taskTimer=setInterval(()=>processBackgroundTasks().catch(e=>captureError('background-worker',e)),30*1000); taskTimer.unref?.();
 client.user.setActivity('protecting your servers');
 if(process.env.HOURLY_OWNER_REPORTS!=='false'){
  console.log('[NexusGuard] Hourly private owner reports enabled. Reports are sent by DM to OWNER_DISCORD_ID.');
  // Run once shortly after startup, then check each minute. The SQLite hourly
  // claim ensures at most one scheduled report per UTC hour per shared DB.
  const reportTimer=setInterval(()=>{sendOwnerHourlyReport().catch(e=>captureError('hourly-owner-report',e));},60*1000);
  reportTimer.unref?.();
  sendOwnerHourlyReport().catch(e=>captureError('hourly-owner-report',e));
 }
 try{await syncSlashCommands();}catch(e){captureError('command-registration',e);}
});
client.on(Events.InteractionCreate,async i=>{if(!i.isChatInputCommand())return;const cmd=commands.find(c=>c.data.name===i.commandName);if(!cmd)return;try{await cmd.execute(i);}catch(e){captureError(`command:${i.commandName}`,e);const msg={content:'Something went wrong while running that command. The error has been logged.',ephemeral:true};if(i.replied||i.deferred)await i.followUp(msg).catch(()=>{});else await i.reply(msg).catch(()=>{});}});
client.on(Events.GuildMemberAdd,async member=>{try{const s=getSettings(member.guild.id);if(s.welcomeEnabled&&s.welcomeChannelId){const ch=member.guild.channels.cache.get(s.welcomeChannelId);if(ch?.isTextBased())await ch.send(s.welcomeMessage.replaceAll('{user}',`${member}`).replaceAll('{server}',member.guild.name).slice(0,1800));}if(s.autoRoleIds?.length)await member.roles.add(s.autoRoleIds.filter(id=>member.guild.roles.cache.has(id))).catch(()=>{});}catch(e){captureError('member-join',e);}});
const recentSpam=new Map();
client.on(Events.GuildMemberRemove,async member=>{try{const s=getSettings(member.guild.id);if(s.leaveEnabled&&s.leaveChannelId){const ch=member.guild.channels.cache.get(s.leaveChannelId);if(ch?.isTextBased())await ch.send(`👋 **${member.user.tag}** has left **${member.guild.name}**.`);}}catch(e){captureError('member-leave',e);}});
client.on(Events.MessageCreate,async m=>{if(!m.guild||m.author.bot)return;try{const s=getSettings(m.guild.id);const now=Date.now();const xpRow=db.prepare('SELECT last_message_at FROM user_xp WHERE guild_id=? AND user_id=?').get(m.guild.id,m.author.id);if(s.levelEnabled&&(!xpRow||now-xpRow.last_message_at>=s.xpCooldownSeconds*1000)){const xp=Math.max(1,Math.min(100,s.xpPerMessage||8));db.prepare(`INSERT INTO user_xp(guild_id,user_id,xp,level,currency,last_message_at) VALUES(?,?,?,0,0,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET xp=xp+excluded.xp,last_message_at=excluded.last_message_at`).run(m.guild.id,m.author.id,xp,now);const row=db.prepare('SELECT xp,level FROM user_xp WHERE guild_id=? AND user_id=?').get(m.guild.id,m.author.id);const level=Math.floor(Math.sqrt(row.xp/100));if(level>row.level){db.prepare('UPDATE user_xp SET level=? WHERE guild_id=? AND user_id=?').run(level,m.guild.id,m.author.id);m.channel.send(`🎉 ${m.author}, you reached **level ${level}**!`).catch(()=>{});}}
const custom=db.prepare('SELECT name,response FROM custom_commands WHERE guild_id=? AND enabled=1').all(m.guild.id);const prefix=s.prefix||'!';if(m.content.startsWith(prefix)){const name=m.content.slice(prefix.length).trim().split(/\s+/)[0]?.toLowerCase();const c=custom.find(x=>x.name===name);if(c){await m.channel.send(c.response.replaceAll('{user}',`${m.author}`).replaceAll('{server}',m.guild.name).slice(0,1900));return;}}
if(!s.automodEnabled)return;
if(s.antiInvite&&/(discord\.gg\/|discord(app)?\.com\/invite\/)/i.test(m.content)&&!m.member.permissions.has(PermissionFlagsBits.ManageGuild)){await m.delete().catch(()=>{});await m.channel.send(`${m.author}, Discord invite links are not allowed here.`).then(x=>setTimeout(()=>x.delete().catch(()=>{}),5000)).catch(()=>{});audit(m.guild.id,client.user.id,'automod_invite',m.author.id);}
if(s.antiMassMention&&m.mentions.users.size>=s.mentionLimit&&!m.member.permissions.has(PermissionFlagsBits.MentionEveryone)){await m.delete().catch(()=>{});audit(m.guild.id,client.user.id,'automod_mass_mention',m.author.id,{mentions:m.mentions.users.size});}
if(s.antiSpam){const key=`${m.guild.id}:${m.author.id}`;const arr=(recentSpam.get(key)||[]).filter(t=>now-t<6000);arr.push(now);recentSpam.set(key,arr);if(arr.length>=6&&!m.member.permissions.has(PermissionFlagsBits.ManageMessages)){await m.member.timeout(60_000,'NexusGuard anti-spam').catch(()=>{});await m.channel.send(`${m.author}, please slow down. Anti-spam temporarily timed you out.`).catch(()=>{});audit(m.guild.id,client.user.id,'automod_spam_timeout',m.author.id,{messages:arr.length});recentSpam.delete(key);}}
}catch(e){captureError('message-handler',e);}});
client.on(Events.GuildCreate,g=>console.log(`[NexusGuard] Joined ${g.name} (${g.id})`));
client.on(Events.GuildDelete,g=>console.log(`[NexusGuard] Removed from ${g.id}`));
client.on(Events.Error,e=>captureError('discord-client',e));
const port=Number(process.env.PORT)||10000;
const server=app.listen(port,'0.0.0.0',()=>console.log(`[NexusGuard] Web server listening on ${port}`));
process.on('unhandledRejection',e=>captureError('unhandled-rejection',e));
process.on('uncaughtException',e=>{captureError('uncaught-exception',e);});
async function shutdown(){console.log('[NexusGuard] Shutting down...');server.close();client.destroy();db.close();process.exit(0)}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
if(process.env.DISCORD_TOKEN){client.login(process.env.DISCORD_TOKEN).catch(e=>captureError('discord-login',e));}
