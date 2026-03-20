# System Awakening — Authoring Guide

Complete reference for all directives available in scene files.

---

## Table of Contents

1. [File Structure](#file-structure)
2. [Variables](#variables)
3. [Flow Control](#flow-control)
4. [Choices](#choices)
5. [Text and Formatting](#text-and-formatting)
6. [Stats, Skills, and Inventory](#stats-skills-and-inventory)
7. [Saving and Checkpoints](#saving-and-checkpoints)
8. [Media](#media)
9. [Glossary](#glossary)
10. [Scenes and Procedures](#scenes-and-procedures)
11. [Linter](#linter)

---

## File Structure

### `startup.txt`
The boot file. Declares global variables and lists all scenes.

```
*create variableName defaultValue
*create_stat key "Display Label" defaultValue

*scene_list
  prologue
  chapter2
  epilogue
```

### Scene files (e.g. `prologue.txt`)
Each scene is a plain text file. Lines beginning with `*` are directives.
Plain text lines are rendered as narrative paragraphs.

```
*title The End of the World

This is a paragraph of narrative text.

*set some_var true
```

---

## Variables

### `*create varName value`
Declares a global persistent variable (in `startup.txt`).
```
*create health "Healthy"
*create level 1
*create inventory []
```

### `*create_stat key "Label" value`
Declares a global stat that appears in the Stats panel.
```
*create_stat body "Body" 50
*create_stat mind "Mind" 50
```

### `*temp varName [value]`
Declares a scene-local variable. Resets when the scene changes.
Must be declared before use.
```
*temp choice_made false
*temp count 0
```

### `*set varName expression`
Sets a variable to a value. Supports arithmetic and string expressions.
```
*set level 5
*set level (level + 1)
*set health "Wounded"
*set inventory_count (length inventory)
```

### `*set_stat varName value [min:N] [max:N]`
Sets a stat variable, optionally clamping to a range.
```
*set_stat body (body + 10) min:0 max:200
```

---

## Flow Control

### `*label name`
Defines a jump target within the current scene.
```
*label chapter_start
```

### `*goto label`
Jumps to a label in the current scene.
```
*goto chapter_start
```

### `*gosub label` / `*return`
Calls a subroutine label and returns when `*return` is reached.
```
*gosub show_warning
...
*label show_warning
  You feel a chill.
*return
```

### `*if` / `*elseif` / `*else`
Conditional branching. Blocks are indented with spaces.
```
*if (level >= 10)
  You feel powerful.
*elseif (level >= 5)
  You're getting there.
*else
  You are still learning.
```

Operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `and`, `or`, `not`

### `*loop condition`
Repeats the indented block while the condition is true.
```
*loop (count < 3)
  *set count (count + 1)
```

### `*goto_scene sceneName`
Navigates to another scene (clears temp state).
```
*goto_scene chapter2
```

### `*gosub_scene sceneName [label]`
Calls another scene as a subroutine (advanced use).
```
*gosub_scene shared_encounter
```

---

## Choices

### `*choice`
Presents branching choices to the player.
```
*choice
  #Option A
    You choose A.
    *goto result_a
  #Option B
    You choose B.
    *goto result_b
```

Choice text supports inline formatting and `${variable}` interpolation.

#### Stat requirement badges
```
*choice
  #[body >= 80] Kick down the door.
    You kick it open.
  #Try the handle instead.
    It opens quietly.
```
Unmet requirements disable the button and show the requirement badge.

### `*random_choice`
Selects one branch randomly by weight. Weights don't need to sum to 100.
The `#label` after the weight is author-facing metadata only.
```
*random_choice
  60 #common
    Nothing unusual happens.
  30 #uncommon
    You find a useful item.
  10 #rare
    Something extraordinary occurs.
```

### `*page_break [buttonText]`
Pauses execution and shows a "Continue" button. Clears the screen when clicked.
```
*page_break
*page_break Continue the journey
```

---

## Text and Formatting

### Paragraphs
Any non-directive line is a paragraph.
```
The room is dark and cold.
```

### Variable interpolation
```
Hello, ${first_name}.
You have ${level} levels.
```

### Pronoun tokens
```
{they} rise from the chair.
{Their} eyes are steady.
You see {them} across the room.
```
Tokens: `{they}` `{them}` `{their}` `{theirs}` `{themself}`
(Capitalised forms: `{They}` `{Them}` etc.)

### Bold and italic
```
[b]bold text[/b]
[i]italic text[/i]
```

### Inline color tags
```
[cyan]cyan text[/cyan]
[amber]amber text[/amber]
[legendary]legendary item[/legendary]
```
Available colors: `cyan` `amber` `green` `red` `white` `blue` `purple` `gold`
`silver` `dim` `faint` `common` `uncommon` `rare` `epic` `legendary`

### `*system text`
Renders a styled [SYSTEM] block. Inline or multi-line.
```
*system +500 Essence gained.

*system
  LEVEL UP
  Body +5, Mind +3
*end_system
```

### `*title text`
Sets the chapter title displayed in the UI header and shows a chapter card.
An optional `[Label]` prefix controls the word shown above the title on the card
(default: "Chapter"). The label does not appear in the chapter bar.
```
*title The Fall of Solace
*title [Prologue] The End of the World
*title [Chapter 1] A New Dawn
*title [Epilogue] What Remains
```

### `*set_game_title "New Title"`
Updates the game title shown on the splash screen.

### `*set_game_byline "Tagline"`
Updates the tagline shown below the game title.

### `*notify "Message" [duration_ms]`
Shows a toast notification. Supports `${variable}` interpolation.
```
*notify "Quest updated."
*notify "Achievement unlocked!" 3000
```

### `*journal text`
Adds an entry to the player's journal (Log tab).
```
*journal You learned the location of the vault.
```

### `*achievement text`
Adds an achievement entry (shown with a special icon in the Log tab).
```
*achievement The First Step — You began the journey.
```

### `*input varName "Prompt"`
Shows an inline text input and stores the result in `varName`.
Variable must be declared with `*create` or `*temp` first.
```
*temp player_answer ""
*input player_answer "What is your answer?"
```

### `*comment text`
Ignored entirely. Use for author notes.
```
*comment TODO: Add more choices here.
```

---

## Stats, Skills, and Inventory

### `*award_essence N` / `*add_essence N`
Awards Essence points to the player.
```
*award_essence 500
```

### `*grant_skill skillKey`
Gives the player a skill defined in `skills.txt`.
```
*grant_skill shield_bash
```

### `*revoke_skill skillKey`
Removes a skill from the player.
```
*revoke_skill shield_bash
```

### `*if_skill skillKey`
Conditionally executes a block if the player has the skill.
```
*if_skill shield_bash
  You raise your shield and bash the door.
```

### `*add_item "Item Name"` / `*grant_item "Item Name"`
Adds an item to the player's inventory.
```
*add_item "Health Potion"
*grant_item "Ward Scroll"
```

### `*remove_item "Item Name"`
Removes one instance of an item from inventory.
```
*remove_item "Health Potion"
```

### `*check_item "Item Name" varName`
Sets `varName` to `true`/`false` based on whether the player has the item.
```
*temp has_key false
*check_item "Vault Key" has_key
*if has_key
  You use the key to open the vault.
```

---

## Saving and Checkpoints

### `*save_point [label]`
Triggers an auto-save at this point.
```
*save_point
*save_point Before the Final Choice
```

### `*checkpoint "Label"`
Creates a named restore point visible in the save menu. Max 5 checkpoints (FIFO rotation).
The label is optional — if omitted, the current chapter title is used.
```
*checkpoint "Chapter 1 — Awakening"
*checkpoint
```

---

## Media

### `media/` directory
Place all image assets in the `media/` directory at the project root.

### Character portrait (`media/portrait.png`)
The character creation screen displays an image from `media/portrait.png`.
Place any `.png`, `.webp`, or `.jpg` file there (update the `src` in `index.html`
if you use a different extension). If the file is missing, the portrait area
hides gracefully with no broken-image icon.

### `*image "filename.ext" [alt:"text"] [width:N]`
Inserts an inline image into the narrative flow from the `media/` directory.
```
*image "cave_entrance.webp"
*image "portrait.png" alt:"A hooded figure in grey armour" width:400
```
- Images are lazy-loaded
- A missing image is hidden gracefully (no broken-image icon)

---

## Glossary

### `data/glossary.txt`
Define terms that will be auto-highlighted with tooltips anywhere they appear in narrative text.

```
*term "Essence"
  A universal energy currency extracted from defeated monsters.

*term "Mana"
  The internal energy reserve used to power skills.
```

### `*define_term "Term Name" description`
Adds or replaces a glossary entry at runtime from within a scene.
```
*define_term "Void Gate" A rift through which demons pass from their realm into ours.
```

Terms are wrapped in `<span class="lore-term">` elements with a CSS tooltip on hover/focus.

---

## Scenes and Procedures

### `*call procedureName`
Calls a procedure defined in `procedures.txt`. Execution returns after the procedure ends.
```
*call level_up_sequence
```

### `procedures.txt`
Defines reusable procedure blocks.
```
*proc level_up_sequence
  *system Level Up! Body +5
  *set level (level + 1)
  *award_essence 100
*end_proc
```

---

## Linter

Run the scene linter to catch authoring errors before playtesting:

```sh
npm run lint
```

The linter checks all scenes in the `*scene_list` for:
- `*goto` / `*gosub` references to undefined labels
- Duplicate `*label` declarations
- `*goto_scene` / `*gosub_scene` references to scenes not in the scene list
- `*call` references to undefined procedures
- `*set`, `*if`, `${var}` uses of variables not declared via `*create` or `*temp`
- `*temp` variables used before their declaration line
- Unused label declarations (warnings)

Use `--strict` to fail on warnings as well as errors:
```sh
npm run lint -- --strict
```

---

## Theme Toggle

A `☀/☽` button in the game header lets players switch between dark mode (default)
and light mode. The preference is saved in `localStorage` and also respects the
OS-level color scheme on first visit.

**No authoring action is needed** — the toggle is automatic and always visible.

---

## Chapter Cards

When `*title` fires in a scene, an animated chapter title card appears at the
top of the current narrative page. The card persists until the narrative is
cleared (on choice selection, `*page_break` Continue, or `*goto_scene`).

Chapter cards are included in the narrative log and are correctly restored by
save/load and undo.

---

*System Awakening Authoring Guide — v1.1 (2026-03-20)*
