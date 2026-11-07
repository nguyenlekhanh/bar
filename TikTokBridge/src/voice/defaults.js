'use strict';

/*
 * Cloud Disco voice defaults.
 *
 * Every spoken line in this file is English (US). Dialogue is editable from the
 * control panel; these values are only the seed used on first launch.
 */

const DIALOGUE_CATEGORIES = [
    'welcome', 'gift', 'follow', 'share', 'vip', 'topdj', 'random'
];

function line(id, text) {
    return { id, text, enabled: true };
}

const DEFAULT_DIALOGUES = {
    welcome: [
        line('welcome-01', 'Yo! Welcome to Cloud Disco, {name}! Let\'s get this party started!'),
        line('welcome-02', 'Everybody make some noise for {name}!'),
        line('welcome-03', 'We got a new party member! Welcome aboard, {name}!'),
        line('welcome-04', 'Hey {name}, grab your spot on the dance floor!'),
        line('welcome-05', 'Look who just walked in! Give it up for {name}!'),
        line('welcome-06', 'Welcome to the hottest party online, {name}!'),
        line('welcome-07', 'The crew keeps growing! Welcome to Cloud Disco, {name}!'),
        line('welcome-08', 'Fresh face on the floor! Let\'s hear it for {name}!'),
        line('welcome-09', 'Cloud Disco just got a little brighter. Welcome, {name}!'),
        line('welcome-10', '{name} is in the building! Let\'s turn this party up!')
    ],
    gift: [
        line('gift-01', 'Whoa! Big shoutout to {name} for that amazing {gift}!'),
        line('gift-02', 'You\'re making this party even bigger, {name}!'),
        line('gift-03', 'Much love to {name}! Let\'s go!'),
        line('gift-04', 'That deserves a huge round of applause! Thank you, {name}!'),
        line('gift-05', '{name} just dropped {gift} on the dance floor! Amazing!'),
        line('gift-06', 'We see you, {name}! Thank you for the {gift}!'),
        line('gift-07', 'Give it up for {name}! That gift was pure fire!'),
        line('gift-08', '{name}, you are a legend! Thank you for the {gift}!'),
        line('gift-09', 'The energy just went through the roof! Big love to {name}!'),
        line('gift-10', 'Cloud Disco loves you, {name}! What a gift!')
    ],
    follow: [
        line('follow-01', 'We got a new supporter! Welcome to Cloud Disco!'),
        line('follow-02', 'Thanks for joining the party, {name}!'),
        line('follow-03', 'Another legend just joined the crew! Welcome, {name}!'),
        line('follow-04', '{name} is officially part of the Cloud Disco family!'),
        line('follow-05', 'A big Cloud Disco welcome to our newest follower, {name}!'),
        line('follow-06', 'The party just got better! Thanks for the follow, {name}!'),
        line('follow-07', 'Give a warm welcome to {name}! They are with us now!'),
        line('follow-08', 'New follower alert! Much love to {name}!'),
        line('follow-09', '{name}, welcome to the movement! Let\'s dance!'),
        line('follow-10', 'We appreciate you, {name}! Welcome to Cloud Disco!')
    ],
    share: [
        line('share-01', 'Thank you for sharing the party, {name}!'),
        line('share-02', '{name} just spread the word! Let\'s make some noise!'),
        line('share-03', 'Big love to {name} for sharing Cloud Disco!'),
        line('share-04', 'The party is going viral! Thanks, {name}!'),
        line('share-05', 'You are bringing the whole crew, {name}! Thank you!'),
        line('share-06', 'Shoutout to {name} for sharing the vibe!'),
        line('share-07', 'More people, more energy! Thanks for the share, {name}!'),
        line('share-08', '{name} knows where the party is! Thank you for sharing!'),
        line('share-09', 'Cloud Disco is spreading! Much love, {name}!'),
        line('share-10', 'That share was a power move, {name}! Let\'s go!')
    ],
    vip: [
        line('vip-01', '{name} just hit VIP status! Light up the dance floor!'),
        line('vip-02', 'Make some noise for our top supporter, {name}!'),
        line('vip-03', 'The spotlight belongs to {name} tonight!'),
        line('vip-04', 'VIP in the building! Show some love for {name}!'),
        line('vip-05', 'That is how you do it, {name}! VIP energy all night!'),
        line('vip-06', 'Cloud Disco royalty! Give it up for {name}!'),
        line('vip-07', '{name} is running the party now! VIP status confirmed!'),
        line('vip-08', 'All eyes on {name}! The VIP section is on fire!'),
        line('vip-09', 'A massive Cloud Disco salute to our VIP, {name}!'),
        line('vip-10', 'Turn the lights up for {name}! VIP excellence!')
    ],
    topdj: [
        line('topdj-01', 'Our number one DJ is taking over the stage, {name}!'),
        line('topdj-02', 'The Top DJ crown belongs to {name}! Make some noise!'),
        line('topdj-03', '{name} is controlling the decks tonight! Let\'s go!'),
        line('topdj-04', 'Top DJ alert! The whole floor belongs to {name}!'),
        line('topdj-05', 'Give it up for the one and only Top DJ, {name}!'),
        line('topdj-06', '{name} just took the party to another level!'),
        line('topdj-07', 'The stage is yours, {name}! Top DJ in the house!'),
        line('topdj-08', 'Cloud Disco presents our Top DJ, {name}!'),
        line('topdj-09', 'That is the Top DJ sound! Respect to {name}!'),
        line('topdj-10', 'Top DJ status unlocked! Cloud Disco goes wild for {name}!')
    ],
    random: [
        line('random-01', 'Come on everybody! Don\'t stop dancing!'),
        line('random-02', 'Let\'s turn up the energy!'),
        line('random-03', 'Where\'s the party crew tonight?'),
        line('random-04', 'I wanna see those hearts flying!'),
        line('random-05', 'The dance floor is heating up!'),
        line('random-06', 'Are you ready for another drop?'),
        line('random-07', 'Cloud Disco, make some noise!'),
        line('random-08', 'Hands up if you are having a good time!'),
        line('random-09', 'The night is young and the beat is loud!'),
        line('random-10', 'Keep the energy high, Cloud Disco!'),
        line('random-11', 'Let me see you move! Let\'s go!'),
        line('random-12', 'This party does not stop! Keep dancing!')
    ]
};

function defaultVoiceConfig() {
    return {
        version: 1,
        enabled: true,
        provider: 'kokoro',
        persona: 'club',
        voice: 'am_michael',
        voiceGender: 'male',
        language: 'en-US',
        speed: 1.0,
        volume: 1.0,
        // +3 dB makes the MC sit above the DJ bed without clipping the WAV.
        boostDb: 3,
        duckLevel: 0.22,
        duckFadeMs: 350,
        maxQueue: 12,
        expireMs: 45000,
        random: {
            enabled: true,
            minSeconds: 150,
            maxSeconds: 300
        },
        events: {
            welcome: true,
            gift: true,
            follow: true,
            share: true,
            vip: true,
            topdj: true,
            random: true
        },
        cooldownsMs: {
            welcome: 15000,
            gift: 6000,
            follow: 30000,
            share: 30000,
            vip: 15000,
            topdj: 30000,
            random: 45000
        },
        username: {
            mode: 'smart',
            maxChars: 40,
            maxWords: 8
        },
        dialogues: JSON.parse(JSON.stringify(DEFAULT_DIALOGUES)),
        pronunciations: []
    };
}

module.exports = {
    DIALOGUE_CATEGORIES,
    DEFAULT_DIALOGUES,
    defaultVoiceConfig
};
