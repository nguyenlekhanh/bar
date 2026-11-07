'use strict';

/*
 * Cloud Disco voice defaults.
 *
 * Every spoken line in this file is English (US). Dialogue is editable from the
 * control panel; these values are only the seed used on first launch.
 */

const DIALOGUE_CATEGORIES = [
    'welcome', 'quiet', 'music', 'energy', 'engage', 'dj',
    'gift', 'follow', 'share', 'vip', 'topdj', 'random'
];

// These pools are safe for autonomous speech: they contain no viewer placeholders
// and never claim that a real viewer sent a message, gift, follow or share.
const AUTONOMOUS_CATEGORIES = ['quiet', 'music', 'energy', 'engage', 'dj', 'random'];

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
        line('welcome-10', '{name} is in the building! Let\'s turn this party up!'),
        line('welcome-11', 'Welcome to the party, {name}! The night is just getting started!'),
        line('welcome-12', 'Join me in welcoming {name} to Cloud Disco!'),
        line('welcome-13', 'The dance floor just got more energy! Welcome, {name}!'),
        line('welcome-14', 'Make some room for {name}! They came to dance!'),
        line('welcome-15', 'Good to see you, {name}! Let\'s make this a night to remember!'),
        line('welcome-16', 'Cloud Disco welcomes {name}! Let the good times roll!')
    ],
    quiet: [
        line('quiet-01', 'It\'s a little quiet in here tonight, but the music never stops!'),
        line('quiet-02', 'Where\'s everybody hiding? Come join the party!'),
        line('quiet-03', 'Don\'t be shy! Come say hello!'),
        line('quiet-04', 'I\'m keeping this dance floor alive tonight!'),
        line('quiet-05', 'The room is calm, but the beat is about to wake it up!'),
        line('quiet-06', 'A little breathing room before the next big moment. Enjoy the groove!'),
        line('quiet-07', 'You don\'t need a crowd to have a good time. Just press play and move!'),
        line('quiet-08', 'The lights are low and the music is warm. Settle in and enjoy!'),
        line('quiet-09', 'This is your sign to turn the volume up and let loose!'),
        line('quiet-10', 'Quiet moments are just the intro to something bigger. Stay with me!'),
        line('quiet-11', 'I\'ve got the music covered. You bring the good vibes!'),
        line('quiet-12', 'Take a breath, feel the rhythm, and get ready for the next drop!'),
        line('quiet-13', 'Cloud Disco is open all night. Pull up a chair or hit the floor!'),
        line('quiet-14', 'The party doesn\'t need a countdown. It needs you to enjoy the moment!'),
        line('quiet-15', 'Soft lights, smooth beat, good company. This is the life!'),
        line('quiet-16', 'Let the music settle in. We\'re just getting comfortable!'),
        line('quiet-17', 'No rush, no pressure. Just good music and a little late-night magic!'),
        line('quiet-18', 'If you\'re listening right now, this next one is for you!'),
        line('quiet-19', 'The floor might be cool, but this playlist is on fire!'),
        line('quiet-20', 'Stay a while. The best part of the night is still ahead!')
    ],
    music: [
        line('music-01', 'Now that\'s a beat you can move to!'),
        line('music-02', 'Feel that rhythm! Let the music take over!'),
        line('music-03', 'We\'re bringing nothing but good vibes tonight!'),
        line('music-04', 'This track has a pulse, and the dance floor knows it!'),
        line('music-05', 'Turn it up and let the bass do the talking!'),
        line('music-06', 'A smooth groove for the late-night crowd!'),
        line('music-07', 'That drop hit just right. Let\'s run it back in our heads!'),
        line('music-08', 'Good music, good lights, good energy. That\'s the Cloud Disco recipe!'),
        line('music-09', 'Listen to that melody. It\'s got midnight written all over it!'),
        line('music-10', 'The rhythm is locked in. All you have to do is move!'),
        line('music-11', 'This one is pure dance-floor fuel!'),
        line('music-12', 'Feel the kick, catch the groove, and stay in the pocket!'),
        line('music-13', 'That\'s the kind of track that makes the whole room move!'),
        line('music-14', 'Smooth, loud, and full of life. That\'s how we do it!'),
        line('music-15', 'Let the beat carry you into the next hour!'),
        line('music-16', 'The DJ booth is warm and the speakers are singing!'),
        line('music-17', 'This is the soundtrack to a night you won\'t forget!'),
        line('music-18', 'Big sound, clean groove, nothing but good energy!'),
        line('music-19', 'If this beat feels good, you already know what to do!'),
        line('music-20', 'We keep the music moving so the night never loses its rhythm!')
    ],
    energy: [
        line('energy-01', 'Come on, everybody! Let\'s turn up the energy!'),
        line('energy-02', 'Who\'s ready to dance?'),
        line('energy-03', 'Let\'s keep this party going!'),
        line('energy-04', 'I want to feel that energy!'),
        line('energy-05', 'Hands up, Cloud Disco! It\'s time to move!'),
        line('energy-06', 'The night is young, so let\'s make it loud!'),
        line('energy-07', 'Bring the heat! This dance floor is waiting!'),
        line('energy-08', 'Turn that energy all the way up!'),
        line('energy-09', 'Let\'s go, party people! The beat is in charge now!'),
        line('energy-10', 'Feel the rush and keep on moving!'),
        line('energy-11', 'This is the moment to let loose and have fun!'),
        line('energy-12', 'Cloud Disco, show me what you\'ve got!'),
        line('energy-13', 'The speakers are hot and the night is ours!'),
        line('energy-14', 'Let\'s make some noise for the best party online!'),
        line('energy-15', 'No sitting still tonight! Get up and groove!'),
        line('energy-16', 'The energy is rising and I\'m here for it!'),
        line('energy-17', 'Keep that fire burning, Cloud Disco!'),
        line('energy-18', 'We\'re going all in on good vibes and great music!'),
        line('energy-19', 'Let the rhythm pull you onto the floor!'),
        line('energy-20', 'This party has no brakes! Let\'s keep it rolling!')
    ],
    engage: [
        line('engage-01', 'Where are you all tuning in from tonight?'),
        line('engage-02', 'What\'s your favorite dance track?'),
        line('engage-03', 'Who\'s still rocking with me?'),
        line('engage-04', 'Drop a hello in the chat!'),
        line('engage-05', 'What song would you play next?'),
        line('engage-06', 'Are you dancing at home or just vibing? Either way, I see you!'),
        line('engage-07', 'What\'s the one song that always gets you moving?'),
        line('engage-08', 'Tell me your go-to karaoke track!'),
        line('engage-09', 'Who\'s got the best dance move in the room?'),
        line('engage-10', 'If you could request one song right now, what would it be?'),
        line('engage-11', 'Are you a front-row dancer or a chill in the back kind of person?'),
        line('engage-12', 'What\'s your favorite part of a night out?'),
        line('engage-13', 'Who\'s listening with headphones right now? Turn it up!'),
        line('engage-14', 'What city is bringing the late-night energy tonight?'),
        line('engage-15', 'If you\'re having a good time, let me know in the chat!'),
        line('engage-16', 'What\'s the last song that gave you chills?'),
        line('engage-17', 'Are you here for the music, the vibe, or both?'),
        line('engage-18', 'What\'s your current favorite artist? I\'m taking notes!'),
        line('engage-19', 'Who\'s ready for a surprise track later tonight?'),
        line('engage-20', 'Give me a shout if you\'re dancing along!')
    ],
    dj: [
        line('dj-01', 'I told the speakers to behave tonight. They didn\'t listen!'),
        line('dj-02', 'My dance moves are powered by coffee and good bass!'),
        line('dj-03', 'I\'m not saying I\'m a legend, but the playlist is doing most of the work!'),
        line('dj-04', 'If this beat were a flavor, it would be extra spicy!'),
        line('dj-05', 'I tried to take a break, but the music had other plans!'),
        line('dj-06', 'The DJ booth is officially a no-sleep zone!'),
        line('dj-07', 'I\'ve got two settings: smooth and smoother. This one is smooth!'),
        line('dj-08', 'You bring the energy, I\'ll bring the tracks. Deal?'),
        line('dj-09', 'I\'m pretty sure the bass just asked for a raise!'),
        line('dj-10', 'No requests for the DJ? Perfect, because I\'ve already got the good stuff!'),
        line('dj-11', 'This next transition is smoother than a fresh haircut!'),
        line('dj-12', 'I\'m here all night, and the playlist is not running out of ideas!'),
        line('dj-13', 'The dance floor called. It wants more bass!'),
        line('dj-14', 'I keep the party moving so you don\'t have to think about the clock!'),
        line('dj-15', 'If you\'re smiling right now, my job is done!'),
        line('dj-16', 'The lights are flashing, the beat is bouncing, and we\'re just getting started!'),
        line('dj-17', 'I don\'t skip tracks. I create moments!'),
        line('dj-18', 'Somewhere between the bass and the melody, we found the perfect vibe!'),
        line('dj-19', 'This is the part of the night where the music does all the talking!'),
        line('dj-20', 'You stay for the vibe, I\'ll stay for the bass. Everybody wins!')
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
        line('gift-10', 'Cloud Disco loves you, {name}! What a gift!'),
        line('gift-11', 'That was a power move, {name}! Thank you for the {gift}!'),
        line('gift-12', 'The party just got louder! Much respect to {name}!')
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
        line('follow-10', 'We appreciate you, {name}! Welcome to Cloud Disco!'),
        line('follow-11', 'You just made the Cloud Disco crew stronger, {name}!'),
        line('follow-12', 'Big love to {name} for joining the party!')
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
        line('vip-10', 'Turn the lights up for {name}! VIP excellence!'),
        line('vip-11', 'That VIP energy is unmatched! Big respect to {name}!'),
        line('vip-12', 'The whole floor feels it when {name} shows up!')
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
        boostDb: 6,
        duckLevel: 0.18,
        duckFadeMs: 350,
        maxQueue: 12,
        expireMs: 45000,
        random: {
            enabled: true,
            minSeconds: 150,
            maxSeconds: 300
        },
        autonomous: {
            enabled: true,
            idleDetection: true,
            idleSeconds: 10,
            allowZeroViewers: true,
            randomDialogue: true,
            maxPerHour: 180,
            categories: AUTONOMOUS_CATEGORIES.slice()
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
    AUTONOMOUS_CATEGORIES,
    DEFAULT_DIALOGUES,
    defaultVoiceConfig
};
