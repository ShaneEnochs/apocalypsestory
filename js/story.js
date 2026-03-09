// ============================================================
// SYSTEM AWAKENING — story.js
// Story node definitions. Each node is consumed by engine.js.
// ============================================================

const storyNodes = {

  // ----------------------------------------------------------
  // PROLOGUE
  // ----------------------------------------------------------

  "intro": {
    title: "The End of Everything",
    text: [
      "The sky was the color of a bruise — deep purple bleeding into black, lit from below by fires that had burned for months. You stood on the ramparts of what had once been a European parliament building, repurposed into humanity's last fortress. Below, a sea of monsters stretched to the horizon.",
      "Your friend Kai stood beside you, sword in hand, cracking jokes about the end of the world because that's what you both did to keep from screaming.",
      '"If this is it," Kai said, grinning through a split lip, "at least we go out swinging."',
      "You gripped your weapon. After three years of fighting, leveling, grinding through a nightmare that had swallowed civilization whole, it had come to this. Two people against an army. The last defenders.",
      "The [Demon Lord] at the center of the horde raised one massive fist.",
      "You charged.",
      "The battle was brief. Brutal. And ultimately, hopeless.",
      "As you lay dying, the world going dark around you, a voice cut through the silence — cultured, calm, and distinctly amused.",
      { system: "A figure appeared. Toga-clad, two-faced, radiating an authority that made your skin crawl.\nJanus — the god of doorways. He was real, and he was standing over your broken body.\n\n\"A single person may travel back. To the very beginning. The Initialization.\nI can send you — but you will arrive with nothing but your memories.\"" }
    ],
    choices: [
      {
        text: "\"Send me back. I'll fix everything.\"",
        next: "awakening"
      },
      {
        text: "\"Why should I trust a god? What's your angle?\"",
        next: "question_janus"
      }
    ]
  },

  // ----------------------------------------------------------
  // QUESTION JANUS
  // ----------------------------------------------------------
  "question_janus": {
    title: "The End of Everything",
    text: [
      'Janus tilted both his heads — one smiling, one frowning.',
      '"My angle? Self-preservation, frankly. The dark gods broke the rules. They added the monster summoning system to what was meant to be a gift of growth. We made our own small adjustment in response. This portal. One person. One chance."',
      'He spread his hands. "I gain nothing from your failure. And everything from your success. The cosmos prefers balance, and right now the scales are tipped toward extinction."',
      "The portal behind him shimmered — a wall of white mist edged in blue light. Through it, you could feel something pulling at you. A sense of *before*. Of mornings and coffee and a world that hadn't yet learned to scream.",
      '"Every moment you hesitate, the window narrows. The choice is yours."'
    ],
    choices: [
      {
        text: '"Fine. Send me back."',
        next: "awakening"
      },
      {
        text: '"I\'ll do it — but not for the gods. For Kai. For everyone."',
        next: "awakening",
        onChoose: (state) => {
          state.flags.motivation_personal = true;
        }
      }
    ]
  },

  // ----------------------------------------------------------
  // AWAKENING — class selection
  // ----------------------------------------------------------
  "awakening": {
    title: "Initialization Day",
    text: [
      "You woke with a gasp, heart hammering, sheets tangled around your legs. For a long, disorienting moment, you just stared at the ceiling — *your* ceiling, in *your* apartment, in a world that was still intact.",
      "Then the blue box appeared.",
      { system: "SYSTEM MESSAGE: Greetings. Welcome to the System.\nWould you like to select [Office Drone] as your class?" },
      "You almost laughed. The same idiotic prompt everyone on Earth was seeing right now — the Initialization, the moment the System had arrived and changed everything. In the other timeline, you'd accepted [Office Drone] because you didn't know any better.",
      "Not this time.",
      "You dismissed the prompt with a thought and swung out of bed. A glance in the mirror confirmed it: younger face, no scars, no haunted look in your eyes. Well, not yet anyway.",
      "Outside, you could already hear car horns and distant shouting. The panic was starting. Within a few hours, the streets would be chaos.",
      "But first — the most important decision of your new life.",
      { system: "SYSTEM MESSAGE: Class selection available. Please choose your path." }
    ],
    choices: [
      {
        text: "Select [Rogue] — the path of shadows, blades, and spectral powers",
        note: "Best early solo potential. Stealth, knives, and the terrifying Spectral Shift.",
        next: "class_rogue"
      },
      {
        text: "Select [Mage] — the path of arcane power and summoning",
        note: "Unmatched magical power. You know summoning rituals months ahead of anyone else.",
        next: "class_mage"
      },
      {
        text: "Select [Fighter] — the path of strength and endurance",
        note: "Simple, brutal, effective. Fighters survive. And in the apocalypse, survival is everything.",
        next: "class_fighter"
      }
    ]
  },

  // ----------------------------------------------------------
  // CLASS NODES
  // ----------------------------------------------------------
  "class_rogue": {
    title: "The Rogue's Path",
    text: [
      '"Select [Rogue]," you commanded aloud. The System responded to verbal orders combined with clear intent — a trick that took most people weeks to figure out.',
      { system: 'SYSTEM MESSAGE: Class selected: Rogue.\nYou have received 5 Skill points. Base stats adjusted.\n\nName: Alex  |  Class: Rogue  |  Level: 0\nHP: Healthy  |  Mana: 110/110\nFortitude: 11  |  Perception: 10  |  Strength: 9\nAgility: 11  |  Magic Power: 11  |  Magic Regen: 10\nFree Points: 0 Stat, 5 Skill' },
      "You used your skill points immediately, picking the same loadout that had carried you through three years of hell: [Stealth], [Knives], and [Hundred Faces] — a disguise skill that was far more useful than it sounded. That left two points for [Piercing Strike], an armor-penetrating attack invaluable against tougher monsters.",
      { system: "Skills acquired: Stealth I  |  Knives I  |  Hundred Faces I  |  Piercing Strike I" },
      "You flicked the status screen away, threw on clothes, grabbed your phone, keys, and wallet. Time to move."
    ],
    onEnter: (state) => {
      state.class = "Rogue";
      state.mana = 110;
      state.maxMana = 110;
      state.stats.fortitude = 11;
      state.stats.perception = 10;
      state.stats.strength = 9;
      state.stats.agility = 11;
      state.stats.magicPower = 11;
      state.stats.magicRegen = 10;
      state.skills.push("Stealth I", "Knives I", "Hundred Faces I", "Piercing Strike I");
    },
    choices: [
      {
        text: "Head to the hardware store before the panic buying starts",
        next: "hardware_store"
      },
      {
        text: "Check on your neighbor Maya — she lives alone and might be freaking out",
        next: "check_neighbor_early"
      }
    ]
  },

  "class_mage": {
    title: "The Mage's Path",
    text: [
      '"Select [Mage]," you spoke clearly, feeling the System acknowledge your intent.',
      { system: 'SYSTEM MESSAGE: Class selected: Mage.\nYou have received 5 Skill points. Base stats adjusted.\n\nName: Alex  |  Class: Mage  |  Level: 0\nHP: Healthy  |  Mana: 130/130\nFortitude: 9  |  Perception: 10  |  Strength: 8\nAgility: 9  |  Magic Power: 13  |  Magic Regen: 12\nFree Points: 0 Stat, 5 Skill' },
      "Higher mana pool, better magical stats — at the cost of being physically frailer. You allocated your skill points to [Mana Bolt], [Arcane Shield], and [Ritual Knowledge] — a rare pick at character creation that most people overlooked. It wouldn't help in combat, but it meant you could set up summoning circles immediately.",
      { system: "Skills acquired: Mana Bolt I  |  Arcane Shield I  |  Ritual Knowledge I" },
      "The System wouldn't offer [Ritual Knowledge] to just anyone — it required the Mage class and a genuine understanding of what rituals *were*. Lucky you'd spent three years learning.",
      "You got dressed, grabbed your essentials, and started planning."
    ],
    onEnter: (state) => {
      state.class = "Mage";
      state.mana = 130;
      state.maxMana = 130;
      state.stats.fortitude = 9;
      state.stats.perception = 10;
      state.stats.strength = 8;
      state.stats.agility = 9;
      state.stats.magicPower = 13;
      state.stats.magicRegen = 12;
      state.skills.push("Mana Bolt I", "Arcane Shield I", "Ritual Knowledge I");
    },
    choices: [
      {
        text: "Head to the hardware store — you'll need chalk, salt, and iron for ritual circles",
        next: "hardware_store"
      },
      {
        text: "Check on your neighbor Maya — she lives alone and might be freaking out",
        next: "check_neighbor_early"
      }
    ]
  },

  "class_fighter": {
    title: "The Fighter's Path",
    text: [
      '"Select [Fighter]." No hesitation. No second-guessing.',
      { system: 'SYSTEM MESSAGE: Class selected: Fighter.\nYou have received 5 Skill points. Base stats adjusted.\n\nName: Alex  |  Class: Fighter  |  Level: 0\nHP: Healthy  |  Mana: 90/90\nFortitude: 13  |  Perception: 9  |  Strength: 12\nAgility: 10  |  Magic Power: 8  |  Magic Regen: 8\nFree Points: 0 Stat, 5 Skill' },
      "Less mana, less magical talent — but significantly tougher and stronger than anyone had any right to be on Day One. You dumped your points into [Power Strike], [Iron Skin] — a passive that reduced physical damage — and [Sweeping Blow], an area attack critical for when monsters started showing up.",
      { system: "Skills acquired: Power Strike I  |  Iron Skin I  |  Sweeping Blow I" },
      "Simple. Effective. Fighters weren't flashy, but they were the backbone of every surviving settlement in the old timeline.",
      "Time to move."
    ],
    onEnter: (state) => {
      state.class = "Fighter";
      state.mana = 90;
      state.maxMana = 90;
      state.stats.fortitude = 13;
      state.stats.perception = 9;
      state.stats.strength = 12;
      state.stats.agility = 10;
      state.stats.magicPower = 8;
      state.stats.magicRegen = 8;
      state.skills.push("Power Strike I", "Iron Skin I", "Sweeping Blow I");
    },
    choices: [
      {
        text: "Head to the hardware store before the panic buying starts",
        next: "hardware_store"
      },
      {
        text: "Check on your neighbor Maya — she lives alone and might be freaking out",
        next: "check_neighbor_early"
      }
    ]
  },

  // ----------------------------------------------------------
  // EARLY CHOICES
  // ----------------------------------------------------------
  "check_neighbor_early": {
    title: "A Knock on the Door",
    text: [
      "You stopped in the hallway and knocked on apartment 4B. A long pause, then the door cracked open. Maya — mid-twenties, dark hair, wide eyes — stared at you like you'd grown a second head.",
      '"You\'re seeing it too, right?" she whispered. "The blue boxes?"',
      '"Yeah. It\'s real, and it\'s going to get worse. Listen — I need you to stay inside, stock up on water, and don\'t open the door for anyone you don\'t know. I\'ll explain everything when I get back."',
      '"How do you know—"',
      '"I just *know*. Trust me, Maya. Stay inside."',
      "She nodded slowly, and you could see her choosing a class on an invisible screen in front of her. At least she wasn't panicking. That was more than most people managed."
    ],
    onEnter: (state) => {
      state.flags.checked_on_maya = true;
    },
    choices: [
      {
        text: "Now head to the hardware store",
        next: "hardware_store"
      }
    ]
  },

  "hardware_store": {
    title: "Supply Run",
    text: [
      "The streets were already getting wild. People swiping at invisible menus, car accidents from distracted drivers, a distant sound of breaking glass. But the real panic hadn't started yet. You had maybe an hour.",
      "The hardware store was open, barely. The manager was behind the counter, looking shell-shocked but functional.",
      '"Interesting day, huh?" you offered.',
      '"That\'s one way to put it." He eyed your calm demeanor suspiciously. "You\'re awfully relaxed about floating blue boxes appearing in everyone\'s vision."',
      '"I figure panicking won\'t help. Just need a few things."',
      "You moved through the aisles with purpose: a solid hunting knife, rock salt, chalk, iron filings, candles, a first aid kit, duct tape, and a heavy-duty flashlight. The list looked like a serial killer's shopping spree or a budget occultist's starter kit.",
      "You paid in cash. In a few days, cash wouldn't matter. But today, it kept things simple.",
      { system: "Skill earned: Knives I (common)\nGrants basic knowledge of knife use, including throwing and noncombat applications.\nAll knives are slightly reinforced and can take more damage." }
    ],
    onEnter: (state) => {
      state.inventory.push("Hunting Knife", "Rock Salt", "Chalk", "Iron Filings", "Candles", "First Aid Kit");
      // Only grant Knives I if not already a Rogue (who starts with it)
      if (state.class !== "Rogue" && !state.skills.includes("Knives I")) {
        state.skills.push("Knives I");
      }
    },
    choices: [
      {
        text: "Head straight home — time to set up defenses",
        next: "return_home"
      },
      {
        text: "The electronics store next door is unattended. Grab a laptop and supplies while you can.",
        next: "loot_electronics",
        onChoose: (state) => { state.flags.looted_store = true; }
      },
      {
        text: "A woman across the street is being harassed by a group taking advantage of the chaos",
        next: "street_rescue"
      }
    ]
  },

  "loot_electronics": {
    title: "Opportunism",
    text: [
      "The electronics store's door was ajar, the owner long gone. You ducked inside and grabbed a laptop, extra batteries, charging cables, and a portable solar charger. In the old timeline, information had been humanity's most valuable resource in the early weeks.",
      "You felt a twinge of guilt, but shoved it down. The world was about to end in slow motion. Property rights were about to become very, very theoretical.",
      "A crash from the back of the store made you freeze.",
      "Two men emerged from the stockroom, arms full of TVs and speakers. They spotted you and one of them grinned — not a friendly grin.",
      '"Hey. Put the bag down and walk away."'
    ],
    onEnter: (state) => {
      state.inventory.push("Laptop", "Solar Charger");
    },
    choices: [
      {
        text: "Put the bag down. Not worth a fight on Day One.",
        next: "back_down"
      },
      {
        text: '"I don\'t think so." Stand your ground.',
        next: "electronics_confrontation"
      }
    ]
  },

  "back_down": {
    title: "Discretion",
    text: [
      "You set the bag on the counter and backed toward the door, hands visible. The two men watched you go, then turned back to their haul.",
      "Not every fight was worth having. You'd learned that the hard way in the other timeline — burned through allies, burned through trust, burned through second chances. Sometimes walking away was the strongest move.",
      "You headed home empty-handed but uninjured."
    ],
    onEnter: (state) => {
      state.inventory = state.inventory.filter(i => i !== "Laptop" && i !== "Solar Charger");
      state.flags.backed_down_looters = true;
    },
    choices: [
      {
        text: "Head home and start preparing",
        next: "return_home"
      }
    ]
  },

  "electronics_confrontation": {
    title: "First Blood",
    text: [
      "You shifted your weight, fingers wrapping around the handle of the hunting knife in your bag. The two men saw the movement and their expressions changed.",
      '"Easy there," the bigger one said, setting down a TV. "Don\'t be stupid."'
    ],
    classText: {
      "Rogue": 'You activated [Stealth], feeling the familiar tingle as the skill partially obscured you from their perception. Their eyes unfocused — just long enough for you to sidestep toward the door. By the time the skill faded, you were already outside with your bag.',
      "Mage": 'You raised one hand and let a [Mana Bolt] crackle between your fingers — a tiny sphere of blue-white energy. It wouldn\'t do much damage, but they didn\'t know that. Both men stumbled backward, faces white. "What the *hell*—" You grabbed your bag and walked out.',
      "Fighter": 'You drew the knife and squared up. Three years of combat experience flowed through you — even in this weaker form, the muscle memory was there. Something in your eyes must have communicated this, because both men took a step back. "Forget it," the smaller one muttered. You grabbed your bag and left.'
    },
    afterClassText: [
      { system: "10 XP gained (conflict resolution)." }
    ],
    onEnter: (state) => {
      state.flags.faced_down_looters = true;
      state.xp += 10;
    },
    choices: [
      {
        text: "Head home",
        next: "return_home"
      }
    ]
  },

  "street_rescue": {
    title: "The Right Thing",
    text: [
      "Three guys had cornered a woman against a parked car. They weren't being violent — yet — but the threatening body language was unmistakable. Taking advantage of the chaos to be the worst version of themselves."
    ],
    classText: {
      "Rogue": 'You activated [Hundred Faces], subtly shifting your features into something harder, meaner — adding scars, a broken nose, dead eyes. You stalked toward the group with the kind of walk that said *I have done terrible things and I enjoyed them.* "Walk away," you growled. They scattered.',
      "Mage": 'You raised your hand and fired a [Mana Bolt] into the sky. The crack of energy was loud enough to make everyone flinch. "Next one\'s lower," you said flatly. The three men bolted.',
      "Fighter": 'You walked up, grabbed the nearest one by the collar, and hurled him into the street with a strength that surprised even you — [Power Strike] channeled through a throw. The other two didn\'t wait around to test if you could do it again.'
    },
    onEnter: (state) => {
      state.flags.rescued_stranger = true;
      state.xp += 15;
    },
    afterClassText: [
      'The woman — shaking, barely holding it together — thanked you breathlessly.',
      '"Get inside. Lock your doors. Don\'t come out until tomorrow." You pressed some supplies into her hands. She nodded and ran.',
      { system: "15 XP gained (heroic action)." }
    ],
    choices: [
      {
        text: "Head home — you've done enough good deeds for one apocalypse",
        next: "return_home"
      }
    ]
  },

  // ----------------------------------------------------------
  // RETURN HOME / PREPARATION
  // ----------------------------------------------------------
  "return_home": {
    title: "Preparations",
    text: [
      "Back in your apartment, door locked, bags emptied on the kitchen table. The real work began.",
      "You knew what was coming. Within three days, the first wild monsters would start appearing. Within a week, people would figure out summoning. Within a month, the first real catastrophes would start as someone summoned something they couldn't control.",
      "You spent an hour setting up your apartment: knife sharpened, supplies organized, furniture rearranged for clear sightlines to the door and windows.",
      "Then came the big decision.",
      "In the other timeline, summoning circles had been the key to rapid advancement. But it was dangerous. Even a low-tier Specter could kill an unprepared Level 0.",
      "You had the knowledge. You had the materials. The question was whether you were ready."
    ],
    choices: [
      {
        text: "Set up a summoning circle and start grinding immediately",
        next: "summon_specter"
      },
      {
        text: "Write a survival guide first — if you publish it anonymously, you could save thousands of lives",
        next: "write_guide"
      },
      {
        text: "Sleep. You're exhausted and making life-or-death decisions while tired is how people die.",
        next: "rest_first"
      }
    ]
  },

  "rest_first": {
    title: "The Wisdom of Patience",
    text: [
      "You set the alarm for four hours and crashed on the couch. It felt absurd — the world was ending in slow motion and you were taking a nap. But you'd learned the hard way that exhaustion killed just as effectively as any monster.",
      "When you woke, the apartment was dark. Outside, the sounds of chaos had dimmed to an uneasy quiet. The initial panic had burned itself out, replaced by a city holding its breath.",
      "You felt sharper. Clearer. Ready.",
      { system: "Well-rested bonus: +1 temporary Perception for 6 hours." }
    ],
    onEnter: (state) => {
      state.flags.rested = true;
      state.stats.perception += 1;
    },
    choices: [
      {
        text: "Now set up that summoning circle",
        next: "summon_specter"
      },
      {
        text: "Write the survival guide while the information is fresh",
        next: "write_guide"
      }
    ]
  },

  "write_guide": {
    title: "A Treatise on Surviving the End of the World",
    text: [
      "You opened the laptop (or grabbed pen and paper) and started writing. The words poured out — three years of hard-won knowledge compressed into something practical and urgent.",
      "*A Treatise on Summoning, Leveling, and the Risks Entailed.*",
      "You covered the basics: how the System worked, how to gain XP safely, which early skills to avoid (anything with \"Blood\" in the name at low levels), and critically, which summoned creatures were manageable solo.",
      "You deliberately left out the most dangerous information. Build guides for min-maxed combat classes, the locations of rare Aspect orbs, anything that would give one person too much power too fast.",
      "Two hours later, you had a solid document. You posted it anonymously to every forum, social media platform, and news site you could access.",
      "Whether anyone would listen was another matter. But in the other timeline, the lack of information in the early days had killed more people than the monsters.",
      { system: "25 XP gained (knowledge sharing — significant impact)." }
    ],
    onEnter: (state) => {
      state.flags.published_guide = true;
      state.xp += 25;
    },
    choices: [
      {
        text: "Now it's time to get stronger. Set up the summoning circle.",
        next: "summon_specter"
      },
      {
        text: "Check on Maya before doing anything dangerous",
        next: "maya_visit",
        condition: (state) => state.flags.checked_on_maya === true
      }
    ]
  },

  "maya_visit": {
    title: "Unexpected Ally",
    text: [
      "You knocked on 4B. Maya opened the door immediately — she'd been watching through the peephole.",
      '"You\'re back. I selected [Healer] because it sounded safe. Was that stupid?"',
      'You blinked. [Healer] was one of the rarest starting classes — it required genuine empathy and a desire to help others as the core motivation. Most people who *tried* to pick it got [Medic] instead.',
      '"That was actually brilliant," you told her honestly. "Healers are the most valuable class in the game. You\'re going to be keeping people alive when nobody else can."',
      'Her expression shifted from anxious to cautiously proud. "I\'ve been reading the status screen. I got a skill called [Triage] — it lets me see how badly someone is hurt just by looking at them."',
      "You filed that away. A Healer ally on Day One was an incredible asset.",
      '"Maya, I\'m about to do something dangerous in my apartment. If you hear me yell, come running. And bring whatever healing skill you\'ve got."',
      "She nodded, jaw set. Braver than she looked."
    ],
    onEnter: (state) => {
      state.flags.maya_ally = true;
    },
    choices: [
      {
        text: "Time for the summoning circle",
        next: "summon_specter"
      }
    ]
  },

  // ----------------------------------------------------------
  // SUMMONING — Test node for XP + level-up trigger
  // ----------------------------------------------------------
  "summon_specter": {
    title: "Summoning and Power Metal",
    text: [
      "You cleared the living room floor and went to work with duct tape, chalk, and iron filings, laying out the summoning circle from memory. Tier 1 to start — a Ghost. The weakest possible summon. Even so, at Level 0, it could kill you if you got careless.",
      "The circle took twenty minutes. Rock salt at the cardinal points, iron filings in the connecting lines, three candles at the outer edge. You double-checked every line, every measurement.",
      "You connected your phone to a speaker and put on the loudest music you had. Not because it helped the ritual — because it covered the sounds of combat.",
      "Knife in hand, you stepped up to the circle.",
      '"Spirit, come forth."',
      "The candles flared. A pale shape erupted from the center — translucent, vaguely humanoid, trailing wisps of cold light. A Ghost. Small, weak, and immediately aggressive.",
      "It lunged."
    ],
    classText: {
      "Rogue": "You sidestepped with practiced ease, knife flashing. The enchanted blade passed through the Ghost's translucent body with a hiss. It shrieked, flickered, and dissolved.",
      "Mage": "You raised your hand and unleashed a [Mana Bolt] directly into its center mass. The magical energy disrupted the Ghost's form instantly. It didn't even have time to scream.",
      "Fighter": "You activated [Power Strike] and swung. The knife, enhanced with the skill's energy, carved through the Ghost's form. It was like punching through cold fog — except this fog screamed and dissolved into sparkling motes of light."
    },
    onEnter: (state) => {
      state.xp += 40;
    },
    afterClassText: [
      { system: "Ghost (Lv. 3) has been slain.\n40 XP gained (30 base * 1.33 due to level disparity)." },
      "The rush of XP was immediate and tangible — a warmth spreading through your body, your stats ticking up by imperceptible fractions. Addictive. No wonder people in the other timeline had gotten reckless."
    ],
    choices: [
      {
        text: "Summon another one. Then another. Grind until you level up.",
        next: "grinding_montage"
      },
      {
        text: "One is enough for now. Rest and reassess.",
        next: "cautious_path"
      }
    ]
  },

  "grinding_montage": {
    title: "The Grind",
    text: [
      "You fell into a rhythm. Summon, fight, recover mana, repeat. Each Ghost went down a little faster than the last. Your body was re-learning the combat instincts that had kept you alive for three years.",
      "The third Ghost clipped you with a frozen claw, leaving a burning scratch across your forearm. The fifth one nearly phased through the wall and attacked from behind. The seventh made you genuinely sweat."
    ],
    flagText: [
      {
        condition: (state) => state.flags.maya_ally,
        items: [
          "Between summons four and five, Maya knocked on the door. She took one look at the scratches on your arms, said \"Sit down,\" and cast [Healing Touch]. The wounds closed in seconds, the pain evaporating like morning dew. You could have kissed her. Platonically. Mostly.",
          '"You\'re insane," she informed you. "Continue."'
        ]
      }
    ],
    afterClassText: [
      "After two hours and nine Ghosts, the notification you'd been waiting for arrived.",
      { system: "Level Up! You are now Level 1.\n+10 Stat Points, +3 Skill Points\nXP: 32/200" },
      "You distributed points immediately. A balanced spread — enough to keep you alive against tougher opponents without over-specializing this early.",
      "The last Ghost had dropped something unusual: a small, glowing orb hovering above the dissolving remains. An Aspect orb. Rare at Tier 1 — you'd been lucky, or the System was feeling generous.",
      { system: "Aspect of the Specter available.\nCost: 1,000 XP to activate.\nGrants: +5 Magic Regeneration\nChoose one skill: Spectral Shift | Specter's Flight | Hunt of the Damned" }
    ],
    onEnter: (state) => {
      // Grant XP for the full grind session (9 ghosts × ~40 XP, minus 40 already granted in summon_specter)
      state.xp += 320;
      // Hard-set level 1 — this is a narrative montage, XP math is approximate
      state.level = 1;
      state.xpToNext = 200;
      state.inventory.push("Aspect Orb (Specter)");
      state.flags.has_aspect_orb = true;
      // Apply level-up stat bonuses
      Object.keys(state.stats).forEach(k => state.stats[k] += 1);
    },
    choices: [
      {
        text: "Push harder. Upgrade to Tier 2 summons — Spirits are tougher but worth more XP.",
        next: "tier2_summon",
        condition: (state) => state.level >= 1
      },
      {
        text: "You've done enough. Check the outside world — it's been hours.",
        next: "venture_outside"
      }
    ]
  },

  "cautious_path": {
    title: "Patience",
    text: [
      "One kill. Enough to confirm the system worked, enough XP to feel the progress. But you knew from bitter experience that overconfidence was the number one killer in the early days.",
      "You cleaned up, bandaged the minor scratch on your arm, and took stock. The sun was setting. Day One was almost over.",
      "Through the window, the city looked wounded but alive. Fires in the distance, sirens, the occasional scream. But also lights in apartment windows, the sound of people calling out to each other. Humanity was scared, confused, but not broken.",
      "Not yet.",
      { system: "XP: 40/100. Level 0." }
    ],
    choices: [
      {
        text: "Venture outside to scout the neighborhood",
        next: "venture_outside"
      },
      {
        text: "Barricade the door and wait for morning",
        next: "wait_morning"
      }
    ]
  },

  // ----------------------------------------------------------
  // NIGHT / ENDINGS (Stub nodes — fleshed out in Phase 3)
  // ----------------------------------------------------------
  "venture_outside": {
    title: "The Changed World",
    text: [
      "The hallway was empty, but the building's front door had been propped open. Outside, the city was a different place than the one you'd left hours ago.",
      "Half the streetlights were out. A car was overturned at the intersection. Graffiti on the nearest wall read \"THE END IS NIGH\" in dripping red paint. A bit on the nose.",
      "More importantly, you could *feel* something different in the air. The System's ambient mana was increasing — the world was slowly saturating with the energy that would eventually allow monsters to manifest naturally.",
      "A sound caught your attention. Down the block, someone was calling for help.",
      "Then, from the opposite direction, a low resonant hum. Someone had set up a summoning circle — a *big* one, way beyond what a Day One player should be attempting."
    ],
    choices: [
      {
        text: "Help the person calling out — someone's trapped and needs rescue",
        next: "rescue_trapped"
      },
      {
        text: "Sprint toward the summoning hum — you need to stop this before it kills someone",
        next: "stop_summoner"
      },
      {
        text: "Both situations are urgent. You can handle both.",
        next: "split_decision",
        condition: (state) => state.level >= 1
      }
    ]
  },

  // Stub — full content in Phase 3
  "tier2_summon": {
    title: "Hubris",
    ending: "death",
    text: [
      "The Spirit erupted from the circle — bigger, faster, angrier than any Ghost. A Tier 2 creature at Level 0 was suicide.",
      "The fight lasted twelve seconds. The Spirit's claws phased through your knife guard and raked across your chest, leaving wounds that burned with supernatural cold. You stumbled. It struck again.",
      "Your last thought, as the world went dark for the second time, was that you really should have known better.",
      { system: "DEATH: Killed by Spirit (Tier 2).\nOverconfidence is a slow and insidious killer — unless it gets you killed immediately." }
    ],
    retryNode: "return_home",
    choices: []
  },

  "rescue_trapped": {
    title: "Under the Rubble",
    text: [
      "You followed the voice to a partially collapsed storefront — the awning had come down during what looked like a minor earthquake. Mana saturation did that in the early days, causing tremors as the world adjusted to the new energy.",
      "A man was pinned under a fallen beam. Middle-aged, calm despite obvious pain, with the hard eyes of someone who'd seen trouble before."
    ],
    classText: {
      "Fighter": 'You braced yourself and activated [Power Strike] — not as an attack, but to enhance your raw strength. The beam shifted, groaned, and lifted enough for the man to drag himself free. Your arms screamed in protest.',
      "Rogue": 'The beam was too heavy to lift directly, but you spotted a metal pipe nearby that could work as a lever. You wedged it under the beam, using the rubble as a fulcrum — basic physics, subtly enhanced by the dexterity bonus from [Knives]. The beam shifted enough for the man to crawl out.',
      "Mage": 'You used [Mana Bolt] at its lowest setting to shatter the weakest section of the beam, splitting it cleanly in two. The pieces were light enough to shove aside. Unconventional use of a combat skill — the System didn\'t seem to mind.'
    },
    afterClassText: [
      '"Thanks," the man grunted, testing his legs. Nothing broken, miraculously. "Name\'s Cole. Ex-military. I was trying to get supplies from my shop when the ceiling decided to disagree."',
      'He looked at you — really looked. "You\'re not scared. And you move like you know what you\'re doing. Either you\'re insane or you know something the rest of us don\'t."',
      { system: "20 XP gained (rescue)." }
    ],
    flagText: [
      {
        condition: (state) => state.flags.published_guide,
        items: [
          '"You haven\'t read the guide going around online, have you?" you said.',
          "Cole's eyes widened. \"That was *you*?\""
        ]
      }
    ],
    onEnter: (state) => {
      state.flags.rescued_cole = true;
      state.xp += 20;
    },
    choices: [
      {
        text: '"Stick with me, Cole. I could use someone who knows how to fight."',
        next: "ally_cole"
      },
      {
        text: '"Get home safe. Things are going to get worse before they get better."',
        next: "cole_leaves"
      }
    ]
  },

  "stop_summoner": {
    title: "The Amateur",
    text: [
      "You sprinted toward the hum, following the mana distortion like a bloodhound. It led you to a basement apartment, door wide open, candlelight flickering from below.",
      "A kid — couldn't be more than nineteen — was kneeling in the center of a summoning circle, chanting from instructions scrawled on notebook paper. The circle was *wrong*. Table salt instead of rock salt, proportions off, mana lines crossing where they shouldn't.",
      "He wasn't summoning a Ghost. He was summoning something much worse, and the circle's flaws meant he wouldn't be able to contain it.",
      '"STOP!" you shouted.',
      'He looked up, startled. "I — I found instructions online. I thought—"',
      "The circle flared. The mana erupted.",
      "Something huge, dark, and very angry began pulling itself through the rift."
    ],
    classText: {
      "Rogue": 'You threw the hunting knife. Not at the creature — at the candle anchoring the north point of the circle. The flame went out and the circle\'s containment collapsed *inward*, crushing the half-formed summon back into whatever dimension it came from. The backlash threw both of you against opposite walls.',
      "Mage": 'You poured your entire mana pool into an [Arcane Shield], slamming it down over the circle like a lid on a pot. The emerging creature thrashed against the barrier while you reached in with your [Ritual Knowledge] to manually destabilize the circle\'s anchor points. The whole thing collapsed in a shower of sparks.',
      "Fighter": 'No time for subtlety. You shoulder-charged the kid out of the circle — breaking the chanter\'s connection was crude but effective. The emerging creature partially materialized: a Phantom, Tier 2, and furious. You activated [Power Strike] and [Sweeping Blow], pouring everything into a devastating combination. Three hits to bring it down, each one leaving you more drained than the last.'
    },
    afterClassText: [
      '"I\'m sorry, I\'m sorry, I didn\'t know—" the kid was shaking.',
      '"You almost killed yourself and everyone in this building," you said, keeping your voice steady even though your hands were trembling. "Where did you get those instructions?"',
      '"Some forum. They said it was easy XP..."',
      "Misinformation was already spreading. In the old timeline, badly constructed summoning circles had killed thousands in the first month.",
      { system: "Crisis averted. 50 XP gained." }
    ],
    onEnter: (state) => {
      state.flags.stopped_bad_summoner = true;
      state.xp += 50;
    },
    choices: [
      {
        text: "Teach the kid how to do it properly — better he learns now than tries again alone",
        next: "teach_kid"
      },
      {
        text: "Destroy his notes and tell him to never try this again",
        next: "warn_kid"
      }
    ]
  },

  "split_decision": {
    title: "Two Fires",
    text: [
      "You were Level 1. Faster, tougher, and more capable than any normal person on this street. And both situations needed you *now*.",
      "You sprinted to the collapsed storefront first — it was closer. With the efficiency of experience, you freed the trapped man in under two minutes, told him to follow you, and bolted toward the summoning hum.",
      "The two of you burst into the basement apartment just as the botched summoning circle erupted. Cole hauled the kid clear while you dealt with the emerging creature.",
      "It was harder with depleted stamina and mana. It was messier. But you managed. Barely.",
      { system: "70 XP gained (multiple crisis resolution, ally coordination)." }
    ],
    onEnter: (state) => {
      state.flags.rescued_cole = true;
      state.flags.stopped_bad_summoner = true;
      state.flags.cole_witnessed_power = true;
      state.xp += 70;
    },
    choices: [
      {
        text: "Form a team. Cole has skills, the kid has potential. You need allies.",
        next: "form_team"
      },
      {
        text: "Part ways for now. You work better alone.",
        next: "night_falls"
      }
    ]
  },

  "teach_kid": {
    title: "Paying It Forward",
    text: [
      "You sat down, took a breath, and walked him through it. The real materials, the proper proportions, the safety precautions. His name was Dez, and once he stopped shaking, he turned out to be a sharp kid with a genuine talent for [Ritual Knowledge].",
      '"Start with Ghosts," you told him. "Nothing else until you\'re Level 3 at minimum. And for the love of everything, use *rock salt*."',
      "He nodded, scribbling notes. On proper paper this time.",
      { system: "15 XP gained (teaching)." }
    ],
    onEnter: (state) => {
      state.flags.taught_dez = true;
      state.flags.has_summoning_student = true;
      state.xp += 15;
    },
    choices: [
      { text: "Head back — it's getting late", next: "night_falls" }
    ]
  },

  "warn_kid": {
    title: "Tough Love",
    text: [
      "You ripped the notebook in half, scattered the remaining materials, and gave the kid the hardest stare you could manage.",
      '"You don\'t have the knowledge for this. You almost opened a door that would have killed everyone in a two-block radius. *Stop*."',
      "He looked like he wanted to argue, but something in your expression killed the impulse.",
      '"If you want to level up safely, stick to the basics. Earn natural XP. Summoning is a shortcut that gets people killed."'
    ],
    onEnter: (state) => {
      state.flags.warned_dez = true;
    },
    choices: [
      { text: "Head back home", next: "night_falls" }
    ]
  },

  "ally_cole": {
    title: "An Alliance Formed",
    text: [
      "Cole fell into step beside you without hesitation. Military efficiency — see a competent leader, follow them.",
      '"What\'s the plan?" he asked.',
      '"Get stronger. Get allies. Prepare for what\'s coming."',
      '"And what\'s coming?"',
      '"Everything."'
    ],
    onEnter: (state) => {
      state.flags.cole_ally = true;
    },
    choices: [
      { text: "Head home and introduce Cole to the situation", next: "night_falls" }
    ]
  },

  "cole_leaves": {
    title: "A Brief Encounter",
    text: [
      "Cole nodded, shook your hand, and limped off into the gathering dusk. You watched him go. In the other timeline, you'd never met a Cole. Maybe he'd survived. Maybe he hadn't. The old timeline was gone, and the new one was yours to shape."
    ],
    choices: [
      { text: "Head home", next: "night_falls" }
    ]
  },

  "form_team": {
    title: "Strength in Numbers",
    text: [
      "By the time you made it back to your apartment building — now with Cole and Dez in tow — the city had gone quiet. Not peaceful quiet. *Waiting* quiet.",
      "The three of you sat around your kitchen table, and you laid out as much truth as you felt was safe.",
      '"The monsters are coming. Not summoned ones — wild ones. The System is changing the world\'s mana density, and in about four days, creatures will start appearing naturally."',
      "Silence.",
      '"And you know all this *how*, exactly?" Cole asked.'
    ],
    choices: [
      {
        text: "Tell them the truth. All of it. Time travel, the apocalypse, everything.",
        next: "truth_ending_setup"
      },
      {
        text: '"I found detailed information from a government leak. They knew this was coming."',
        next: "lie_ending_setup"
      }
    ]
  },

  "wait_morning": {
    title: "The Long Night",
    text: [
      "You pushed the couch against the door, set the knife within arm's reach, and settled in for what would be the longest night of your (second) life.",
      "Sleep came in fragments. Every creak of the building, every distant shout jolted you awake. At some point around 3 AM, something scratched at the window — something with too many fingers and not enough body. You held your breath. It moved on.",
      "By dawn, you were exhausted but alive. And the world outside had changed."
    ],
    flagText: [
      {
        condition: (state) => state.flags.published_guide,
        items: [
          "Your phone was exploding with notifications. The guide had gone viral — millions of views, thousands of comments. Most people were skeptical, but enough had tried the advice and confirmed it worked. You'd just become the anonymous voice of humanity's survival.",
          "The comments ranged from *\"this saved my life\"* to *\"obvious government psyop.\"* Classic internet.",
          { system: "Guide impact bonus: +50 XP\nStatus: Guide went viral — millions reached." }
        ]
      }
    ],
    onEnter: (state) => {
      if (state.flags.published_guide) {
        state.xp += 50;
        state.flags.guide_went_viral = true;
      }
    },
    choices: [
      { text: "Head out to scout and gather resources", next: "venture_outside" },
      { text: "Set up the summoning circle — you've lost time, need to catch up", next: "summon_specter" }
    ]
  },

  "night_falls": {
    title: "Night Falls",
    text: [
      "Back in your apartment as darkness settled over the city. The first day was ending, and you were alive, armed, and further ahead than anyone else on the planet.",
      "Your phone buzzed. A notification from the System — the first global one.",
      { system: "SYSTEM MESSAGE — GLOBAL ANNOUNCEMENT:\nDay 1 complete. Worldwide Initialization confirmed.\n7.8 billion humans registered.\nSystem integration: 0.3% complete.\nEstimated time to first natural mana manifestation: 96 hours." },
      "Four days. Then the real nightmare began.",
      "You stared at the ceiling, running calculations. In the other timeline, the first natural mana beasts had appeared in wilderness areas and slowly moved toward population centers. Cities had a buffer — too much concrete and steel for mana to concentrate easily. But that buffer wasn't permanent.",
      "You needed to be at least Level 5 by then. Ideally higher."
    ],
    flagText: [
      {
        condition: (state) => state.flags.has_aspect_orb,
        items: [
          "And you still had that Aspect orb sitting in a bowl on your kitchen table, glowing softly. 1,000 XP to activate. At your current rate, maybe two more days of hard grinding."
        ]
      }
    ],
    afterClassText: [
      "Tomorrow would be harder. But for the first time in either timeline, you felt something like hope."
    ],
    choices: [
      {
        text: "Tomorrow: aggressive grinding. Push for rapid advancement.",
        next: "ending_vanguard"
      },
      {
        text: "Tomorrow: community building. Find survivors, organize defenses.",
        next: "ending_defender"
      },
      {
        text: "Tomorrow: go hunting. The forest will have the first wild mana beasts soon.",
        next: "ending_hunter"
      }
    ]
  },

  "truth_ending_setup": {
    title: "The Unbelievable Truth",
    text: [
      "You told them everything. The timeline, the apocalypse, the Demon Lords, the god who'd sent you back. Every word sounded more insane than the last.",
      "When you finished, the silence stretched like a wire about to snap."
    ],
    flagText: [
      {
        condition: (state) => state.flags.cole_witnessed_power,
        items: [
          'Cole spoke first. "I saw what you did in that basement. The way you moved, the way you *knew* what was happening before it happened. No amount of government leaks explains that." He leaned back. "I believe you."'
        ]
      },
      {
        condition: (state) => !state.flags.cole_witnessed_power && (state.flags.rescued_cole || state.flags.cole_ally),
        items: [
          'Cole was quiet for a long time. Then: "I\'ve seen men who\'ve been to war. Who carry it in their eyes. You have that. Somehow. So yes — I believe you."'
        ]
      },
      {
        condition: (state) => state.flags.maya_ally,
        items: [
          'Maya studied you with that unnerving [Triage] gaze — reading not just wounds but something deeper. "My skill doesn\'t just read physical injuries. Your stress patterns, your cortisol levels — you read like someone who\'s been in combat for years. Not hours." She paused. "I believe you."'
        ]
      }
    ],
    afterClassText: [
      'Dez shrugged. "Dude, we literally have magic powers and floating blue screens. Time travel isn\'t even the weirdest thing that happened today."',
      "Fair point.",
      "With the truth between you, the planning began in earnest. Real planning. The kind that could save not just your lives, but thousands of others."
    ],
    choices: [
      {
        text: "Focus on building a local defense network",
        next: "ending_defender"
      },
      {
        text: "Focus on rapid advancement — your team needs to be strong enough",
        next: "ending_vanguard"
      }
    ]
  },

  "lie_ending_setup": {
    title: "A Convenient Story",
    text: [
      '"Government leak," you said smoothly. "They detected anomalous energy readings months ago. Some insiders got the word out before the Initialization."',
      "It was a clean lie. Believable, especially in the current chaos. Cole nodded slowly. Dez accepted it without question.",
      "The lie worked. But it also meant your authority rested on a fiction.",
      "Well. You'd deal with that when it happened."
    ],
    onEnter: (state) => {
      state.flags.told_lie = true;
    },
    choices: [
      { text: "Focus on building a local defense network", next: "ending_defender" },
      { text: "Focus on rapid power advancement for the team", next: "ending_vanguard" }
    ]
  },

  // ----------------------------------------------------------
  // ENDINGS
  // ----------------------------------------------------------
  "ending_defender": {
    title: "Ending — The Shield",
    ending: "win",
    endingLabel: "THE SHIELD",
    text: [
      "Over the next three days, you transformed your apartment building into a fortress."
    ],
    flagText: [
      {
        condition: (state) => state.flags.maya_ally,
        items: [
          "Maya became the building's medic, healing injuries and earning XP at a rate that shocked even you. By Day 3, she was Level 2 — the fastest Healer progression you'd ever seen."
        ]
      },
      {
        condition: (state) => state.flags.rescued_cole || state.flags.cole_ally,
        items: [
          "Cole organized the defense. Barricades, watch schedules, supply runs — his military experience turned a panicked apartment building into a functioning outpost. He selected [Sentinel] as his class, gaining skills in perception and fortification."
        ]
      },
      {
        condition: (state) => state.flags.taught_dez || state.flags.has_summoning_student,
        items: [
          "Dez, to your surprise, turned into an excellent ritual specialist. His summoning circles were clean, precise, and safe. He started training others — carefully, with your oversight."
        ]
      },
      {
        condition: (state) => state.flags.published_guide,
        items: [
          "Your guide had reached hundreds of millions. Translations appeared in every major language. The death rate in the first week was already trending lower than it had been in the original timeline. You'd never know exactly how many lives you'd saved — but the numbers were significant."
        ]
      }
    ],
    afterClassText: [
      "When the first wild Specter materialized in the building's courtyard on Day 4, your residents were ready. Organized, armed, and led by someone who'd survived this once before.",
      "The Specter never stood a chance.",
      { system: "SYSTEM MESSAGE — PERSONAL NOTE:\nTimeline variance detected.\nProjected survival rate in local area: 340% above baseline.\nSignificant deviation from original outcome logged." },
      "You stood on the roof that evening, watching fires burn on the horizon where other neighborhoods weren't as prepared. There was so much work to do. So many people to save.",
      "But for the first time in either timeline, you felt something you hadn't felt in years. Hope."
    ],
    endingSubtitle: "You chose protection over power, community over advancement. The road ahead is long and the true threats are still years away. But humanity has something it didn't have before — a fighting chance, and someone who knows what's coming.",
    choices: []
  },

  "ending_vanguard": {
    title: "Ending — The Sword",
    ending: "win",
    endingLabel: "THE SWORD",
    text: [
      "You threw yourself into advancement with the desperate focus of someone who'd seen how the story ended. Summon, fight, level, repeat. Higher tiers, tougher creatures, greater risks."
    ],
    flagText: [
      {
        condition: (state) => state.flags.maya_ally,
        items: [
          "Maya had leveled too — her healing keeping you alive through fights that should have killed you twice over. You owed her your life three times and counting."
        ]
      },
      {
        condition: (state) => state.flags.rescued_cole || state.flags.cole_ally,
        items: [
          "Cole trained alongside you, selecting [Warrior] and pushing himself with the kind of iron discipline that only military service could instill. He was Level 2 and climbing."
        ]
      },
      {
        condition: (state) => state.flags.has_aspect_orb,
        items: [
          "That night, you finally activated the Aspect of the Specter. The power that flooded through you was intoxicating — the ability to phase through walls, to become half-ghost, to walk between the physical and ethereal worlds. A rare power, claimed on Day 4.",
          { system: "Aspect of the Specter: ACTIVATED\n[Spectral Shift] acquired — Phase through solid matter for 3 seconds.\n+5 Magic Regeneration applied.\nThis Aspect is visible to all System users." }
        ]
      }
    ],
    afterClassText: [
      "By Day 3, you were Level 4 — weeks ahead of where anyone else on the planet should be.",
      "On Day 4, when the first wild Phantom materialized in the park three blocks away, you were waiting for it. The fight was fast, brutal, and one-sided — in your favor. The creature barely landed a hit before your combined assault tore it apart.",
      "The XP surge pushed you to Level 5.",
      "The Demon Lords were still years away. But when they came, you'd be ready."
    ],
    endingSubtitle: "You chose power. Raw, personal, devastating power. The apocalypse is still coming, but this time it will meet a blade sharp enough to cut fate itself. Whether you can protect others while chasing strength remains to be seen.",
    choices: []
  },

  "ending_hunter": {
    title: "Ending — The Pioneer",
    ending: "win",
    endingLabel: "THE PIONEER",
    text: [
      "While the rest of the city hunkered down, you went *out*.",
      "The forest on the city's outskirts was already changing. The mana was thicker here — trees seemed taller, shadows deeper, and the air had an electric tingle that made your skin crawl. This was where the first natural creatures would appear, and you intended to be waiting."
    ],
    flagText: [
      {
        condition: (state) => state.flags.rescued_cole || state.flags.cole_ally,
        items: [
          'Cole came with you. "If we\'re going to fight monsters in the woods," he said, lacing up boots, "I\'d rather do it with someone who knows what they\'re doing than sit in an apartment waiting to be surprised."'
        ]
      }
    ],
    afterClassText: [
      "You set up a base camp, laid summoning circles for practice fights, and patrolled the perimeter with a methodical intensity that bordered on obsession.",
      "On Day 3, you found it: a spot where the mana was pooling, thickening, coalescing. A natural spawning point. The first one within miles of the city. You marked it, set traps around it, and waited.",
      "The creature that appeared on Day 4 was a Mana Wolf — not on any summoning list, not in any guide. Beautiful and terrible, glowing blue eyes and teeth that could bite through steel.",
      "The fight was the hardest of your new life. The wolf was fast, smart, and had abilities you'd never seen at this tier level. But you had three years of apocalypse survival honed to a razor's edge.",
      "When it finally fell, the System notification was something you'd never seen before.",
      { system: "First Kill bonus — Natural Mana Beast (regional).\nTitle earned: [Pioneer]\n+100 bonus XP. +1 to all stats.\nThis title is permanent and visible to all System users." },
      "You stood over the dissolving wolf, breathing hard, blood running from a dozen small wounds, and grinned.",
      "The apocalypse was coming. But this time, you were hunting *it*."
    ],
    endingSubtitle: "You chose the wild path — to meet the coming storm head-on, in the places where the world was changing fastest. The frontier calls.",
    choices: []
  },

  "death_summoning": {
    title: "Hubris",
    ending: "death",
    text: [
      "The Spirit erupted from the circle — bigger, faster, angrier than any Ghost. A Tier 2 creature at Level 0 was suicide, and you knew it even as you made the choice.",
      "The fight lasted twelve seconds.",
      "Your last thought, as the world went dark for the second time, was that you really should have known better.",
      { system: "DEATH: Killed by Spirit (Tier 2).\nOverconfidence is a slow and insidious killer —\nunless it gets you killed immediately." }
    ],
    retryNode: "return_home",
    choices: []
  },

  // ----------------------------------------------------------
  // TD-03 / TD-08 RESOLVED: death_phantom and day_two_explore
  // ----------------------------------------------------------

  "death_phantom": {
    title: "Too Much, Too Soon",
    ending: "death",
    text: [
      "The partially manifested Phantom was stronger than anything you'd faced in either timeline at this level. Your skills weren't enough. Your stats weren't enough.",
      "You knew, in those final seconds, that foreknowledge wasn't invincibility. It just meant you could see exactly how badly things had gone wrong.",
      "As the creature's spectral jaws closed, you thought: *at least I got further than last time.*",
      "Small comfort.",
      { system: "DEATH: Killed by Phantom (Tier 2, partial manifestation).\nKnowledge without power is a story with no ending." }
    ],
    retryNode: "venture_outside",
    choices: []
  },

  "day_two_explore": {
    title: "A New Dawn",
    text: [
      "Morning light revealed a changed world. The streets were quieter than yesterday — fewer panicking crowds, more barricaded windows. People were adapting. Slowly, clumsily, but adapting.",
      "You could feel the mana density ticking upward, slow and steady, like a tide coming in. In three days it would crest into something tangible. Something dangerous.",
      "You had four days before wild creatures appeared. The question was how to use them."
    ],
    choices: [
      {
        text: "Set up the summoning circle and start grinding — no more delays",
        next: "summon_specter"
      },
      {
        text: "Explore the city, find allies, gather intelligence",
        next: "venture_outside"
      }
    ]
  }

};
