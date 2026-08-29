// Gamerule tables for the two Minecraft profiles.
//
// These exist as data rather than as more `consoleCommands` entries because a
// gamerule is not one command, it is a two-slot one: `gamerule <rule> <value>`,
// and which values are legal depends on which rule was picked. The console's
// word-by-word suggestions read that dependency off the `values` field on each
// option (see argValues in docs/games.md), so `gamerule keep_inventory ` offers
// true/false while `gamerule random_tick_speed ` offers numbers.
//
// Java and Bedrock overlap heavily but neither list is a subset of the other --
// Bedrock has pvp and showCoordinates, Java has spawn_wardens and a dozen rules
// Bedrock never got. They are kept as two tables rather than one with flags so
// each profile only offers rules its server will actually accept.
//
// The two are not even spelled the same way any more: Java moved to snake_case
// in 26.2 while Bedrock kept camelCase, so `keep_inventory` and `keepInventory`
// are both current -- each on its own edition. Do not "fix" one to match the
// other.

const BOOL = ['true', 'false'];

// Numeric rules get a few useful values rather than a range: the box still
// takes any number typed by hand, these are just the ones worth one keystroke.
// The vanilla default is listed first.
const rule = (value, description, values = BOOL) => ({ value, description, values });

// Minecraft 26.2 renamed every Java gamerule to snake_case and, for a good
// number of them, changed the word as well: `doTileDrops` became `block_drops`,
// `naturalRegeneration` became `natural_health_regeneration`, `spawnRadius`
// became `respawn_radius`. The `do` prefix is gone throughout, and several
// rules were re-expressed from the opposite direction -- `disableRaids` is now
// `raids`, `disableElytraMovementCheck` is now `elytra_movement_check`, so the
// value that used to mean "off" now means "on".
//
// This matters more than a rename usually would, because the old name fails in
// a way that reads as the player's fault: the server answers "Incorrect
// argument for command" with the caret under the rule name, which looks exactly
// like a typo or a missing permission rather than a command that no longer
// exists. Every guide and video written before 26.2 still says `keepInventory`.
//
// This list was read out of GameRules.class in the running server jar and then
// confirmed one rule at a time against the live server over RCON, which is also
// where the defaults below come from. Do not hand-edit it against a wiki page;
// re-read it from the jar of whatever version is actually installed.
export const javaGamerules = [
  rule('advance_time', 'Time of day advances'),
  rule('advance_weather', 'Weather changes on its own'),
  rule('allow_entering_nether_using_portals', 'Nether portals can be entered'),
  rule('block_drops', 'Broken blocks drop items'),
  rule('block_explosion_drop_decay', 'Block explosions destroy some of the drops'),
  rule('command_block_output', 'Command blocks tell operators what they ran'),
  rule('command_blocks_work', 'Command blocks run at all'),
  rule('drowning_damage', 'Players take drowning damage'),
  rule('elytra_movement_check', 'Run the server-side elytra speed check'),
  rule('ender_pearls_vanish_on_death', 'Thrown ender pearls vanish when the thrower dies'),
  rule('entity_drops', 'Minecarts, boats and frames drop items when broken'),
  rule('fall_damage', 'Players take fall damage'),
  rule('fire_damage', 'Players take fire damage'),
  rule('fire_spread_radius_around_player', 'Blocks from a player within which fire spreads', ['128', '0', '32']),
  rule('forgive_dead_players', 'Angered neutral mobs calm down once the target dies'),
  rule('freeze_damage', 'Powder snow freezes players'),
  rule('global_sound_events', 'Boss and event sounds are heard world-wide'),
  rule('immediate_respawn', 'Skip the death screen and respawn at once'),
  rule('keep_inventory', 'Items and XP stay with you when you die'),
  rule('lava_source_conversion', 'Lava can form new source blocks'),
  rule('limited_crafting', 'Only unlocked recipes can be crafted'),
  rule('locator_bar', 'Show the locator bar'),
  rule('log_admin_commands', 'Operator commands are written to the server log'),
  rule('max_block_modifications', 'Blocks one fill/clone command may change', ['32768', '1000', '100000']),
  rule('max_command_forks', 'Branches one command may fan out into', ['65536', '1000', '1000000']),
  rule('max_command_sequence_length', 'Commands one chain may run', ['65536', '10000', '1000000']),
  rule('max_entity_cramming', 'Entities in one block before they take damage', ['24', '0', '10', '100']),
  rule('max_snow_accumulation_height', 'Layers of snow a storm may leave', ['1', '0', '8']),
  rule('mob_drops', 'Mobs drop items and XP'),
  rule('mob_explosion_drop_decay', 'Creeper explosions destroy some of the drops'),
  rule('mob_griefing', 'Mobs can change blocks - creepers, endermen, villagers'),
  rule('natural_health_regeneration', 'Health regenerates from a full hunger bar'),
  rule('player_movement_check', 'Run the server-side player movement check'),
  rule('players_nether_portal_creative_delay', 'Ticks in a portal before a creative player travels', ['0', '1', '80']),
  rule('players_nether_portal_default_delay', 'Ticks in a portal before a survival player travels', ['80', '0', '1']),
  rule('players_sleeping_percentage', 'Percent of players who must sleep to skip the night', ['100', '50', '1', '0']),
  rule('projectiles_can_break_blocks', 'Arrows and other projectiles can break blocks'),
  rule('raids', 'Raids can start'),
  rule('random_tick_speed', 'How fast crops grow and leaves decay', ['3', '0', '1', '10', '100']),
  rule('reduced_debug_info', 'Hide coordinates and detail from the F3 screen'),
  rule('respawn_radius', 'Blocks around spawn a player may appear in', ['10', '0', '64']),
  rule('send_command_feedback', 'Commands reply in chat'),
  rule('show_advancement_messages', 'Announce advancements in chat'),
  rule('show_death_messages', 'Deaths are announced in chat'),
  rule('spawn_mobs', 'Mobs spawn naturally'),
  rule('spawn_monsters', 'Hostile mobs spawn'),
  rule('spawn_patrols', 'Pillager patrols spawn'),
  rule('spawn_phantoms', 'Phantoms spawn for players who have not slept'),
  rule('spawn_wandering_traders', 'Wandering traders appear'),
  rule('spawn_wardens', 'Wardens spawn in the deep dark'),
  rule('spawner_blocks_work', 'Monster spawners produce mobs'),
  rule('spectators_generate_chunks', 'Spectators load new terrain'),
  rule('spread_vines', 'Vines grow to nearby blocks'),
  rule('tnt_explodes', 'Lit TNT explodes'),
  rule('tnt_explosion_drop_decay', 'TNT destroys some of the drops'),
  rule('universal_anger', 'Angered neutral mobs attack every player, not just the one'),
  rule('water_source_conversion', 'Water can form new source blocks'),
];

export const bedrockGamerules = [
  rule('commandBlockOutput', 'Command blocks tell operators what they ran'),
  rule('commandBlocksEnabled', 'Command blocks run at all'),
  rule('doDaylightCycle', 'Time of day advances'),
  rule('doEntityDrops', 'Minecarts, boats and frames drop items when broken'),
  rule('doFireTick', 'Fire spreads and burns out'),
  rule('doImmediateRespawn', 'Skip the death screen and respawn at once'),
  rule('doInsomnia', 'Phantoms spawn for players who have not slept'),
  rule('doLimitedCrafting', 'Only unlocked recipes can be crafted'),
  rule('doMobLoot', 'Mobs drop items and XP'),
  rule('doMobSpawning', 'Mobs spawn naturally'),
  rule('doTileDrops', 'Broken blocks drop items'),
  rule('doWeatherCycle', 'Weather changes on its own'),
  rule('drowningDamage', 'Players take drowning damage'),
  rule('fallDamage', 'Players take fall damage'),
  rule('fireDamage', 'Players take fire damage'),
  rule('freezeDamage', 'Powder snow freezes players'),
  rule('functionCommandLimit', 'Commands one function may run per tick', ['10000', '1000', '100000']),
  rule('keepInventory', 'Items stay with you when you die'),
  rule('maxCommandChainLength', 'Commands one chain may run', ['65536', '10000', '1000000']),
  rule('mobGriefing', 'Mobs can change blocks - creepers, endermen, villagers'),
  rule('naturalRegeneration', 'Health regenerates from a full hunger bar'),
  rule('playersSleepingPercentage', 'Percent of players who must sleep to skip the night', ['100', '50', '0']),
  rule('projectilesCanBreakBlocks', 'Arrows and other projectiles can break blocks'),
  rule('pvp', 'Players can damage each other'),
  rule('randomTickSpeed', 'How fast crops grow and leaves decay', ['1', '0', '3', '10']),
  rule('recipesUnlock', 'Recipes unlock as their ingredients are found'),
  rule('respawnBlocksExplode', 'Beds and respawn anchors explode in the wrong dimension'),
  rule('sendCommandFeedback', 'Commands reply in chat'),
  rule('showBorderEffect', 'The world border shows a visible effect'),
  rule('showCoordinates', 'Coordinates on every player\'s HUD'),
  rule('showDaysPlayed', 'Show the day counter'),
  rule('showDeathMessages', 'Deaths are announced in chat'),
  rule('showTags', 'Name tags are visible'),
  rule('spawnRadius', 'Blocks around spawn a player may appear in', ['5', '0', '64']),
  rule('tntExplodes', 'Lit TNT explodes'),
  rule('tntExplosionDropDecay', 'TNT destroys some of the drops'),
];
