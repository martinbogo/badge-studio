// Copyright 2026 Martin Bogomolni
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Bitmap faces for an 11px-tall display.
//!
//! Glyphs carry their own width, so a face can be proportional and a wide
//! pictograph can sit next to a narrow 'i'. Text is composed into a pixel grid
//! and packed into the protocol's byte columns only at the very end, which is
//! what lets glyph width and the wire's 8px granularity stop being the same
//! number.
//!
//! Faces are generated from the pixel art in `fonts/*.face` by
//! `fonts/build.py`. Edit the art, not the tables.

mod serif;

/// Rows per glyph, which is the badge's height.
pub const GLYPH_ROWS: usize = 11;
/// Bits in a glyph row. Bit 15 is x=0, so a glyph's origin is a fixed bit
/// whatever its width.
pub const GLYPH_FIELD: usize = 16;

#[derive(Clone, Copy)]
pub struct Glyph {
    /// Pixels the pen advances after drawing, side bearing included.
    pub advance: u8,
    pub rows: [u16; GLYPH_ROWS],
}

pub struct Face {
    pub id: &'static str,
    pub name: &'static str,
    /// Attribution, shown wherever the face is credited.
    pub notice: &'static str,
    /// Cyclic per-glyph vertical offsets, in pixels, applied by position in the
    /// string. This is what makes a face read as hand-lettered rather than
    /// typeset: at 11px the bounce between letters carries more of that
    /// character than any amount of curve in the letterforms themselves.
    /// Empty for a face that sits flat on the baseline.
    pub jitter: &'static [i8],
    /// Whether this face is offered in the typeface picker. A face of nothing
    /// but pictographs has no letters to typeset with, so it earns its place
    /// in the fallback chain rather than in the menu.
    pub pickable: bool,
    pub glyphs: &'static [(char, Glyph)],
}

impl Face {
    pub fn glyph(&self, c: char) -> Option<&'static Glyph> {
        self.glyphs
            .binary_search_by_key(&c, |(ch, _)| *ch)
            .ok()
            .map(|i| &self.glyphs[i].1)
    }
}

/// Every face, in fallback order. A glyph missing from the chosen face is
/// looked up here in turn, so an emoji typed while Serif is selected still
/// draws instead of turning into '?'.
pub static FACES: &[&Face] = &[&serif::SERIF];

pub const DEFAULT_FACE: &str = "serif";

pub fn face(id: &str) -> Option<&'static Face> {
    FACES.iter().copied().find(|f| f.id == id)
}

/// Characters that must not draw or take up room.
///
/// A pasted emoji is rarely one code point. Variation selectors, the
/// zero-width joiner and the skin-tone modifiers all arrive alongside the
/// pictograph, and rendering them as '?' turns one heart into two glyphs, one
/// of which is a question mark.
fn is_ignorable(c: char) -> bool {
    matches!(c,
        '\u{200D}'                  // zero-width joiner
        | '\u{FE0E}' | '\u{FE0F}'   // text and emoji variation selectors
        | '\u{1F3FB}'..='\u{1F3FF}' // skin tone modifiers
    )
}

/// The face that will actually draw `c`, and its glyph.
///
/// Resolution has to be shared by measuring and drawing, or the editor budgets
/// against one width and stamps another.
fn resolve(chosen: &'static Face, c: char) -> Option<(&'static Face, &'static Glyph)> {
    if let Some(g) = chosen.glyph(c) {
        return Some((chosen, g));
    }
    FACES.iter().find_map(|f| f.glyph(c).map(|g| (*f, g)))
}

/// Pixels `c` occupies, drawn in `chosen` or whichever face has to stand in.
/// Unmapped characters draw as '?' and cost its width.
pub fn advance(chosen: &'static Face, c: char) -> usize {
    if is_ignorable(c) {
        return 0;
    }
    match resolve(chosen, c) {
        Some((_, g)) => g.advance as usize,
        None => chosen.glyph('?').map_or(0, |g| g.advance as usize),
    }
}

/// Pixels `text` occupies once stamped. Held to the same answer as [`layout`]
/// by `measure_matches_layout`.
pub fn measure(chosen: &'static Face, text: &str) -> usize {
    text.chars().map(|c| advance(chosen, c)).sum()
}

pub struct Layout {
    /// GLYPH_ROWS rows of `width` pixels.
    pub rows: Vec<Vec<bool>>,
    pub width: usize,
    /// Characters no face could draw, reported once each.
    pub missing: Vec<char>,
}

/// Draw `text` into a pixel grid.
pub fn layout(chosen: &'static Face, text: &str) -> Layout {
    let width = measure(chosen, text);
    let mut rows = vec![vec![false; width]; GLYPH_ROWS];
    let mut missing = Vec::new();
    let mut pen = 0usize;

    for (i, c) in text.chars().enumerate() {
        if is_ignorable(c) {
            continue;
        }
        let (drawn, glyph) = match resolve(chosen, c) {
            Some(hit) => hit,
            None => {
                if !missing.contains(&c) {
                    missing.push(c);
                }
                match chosen.glyph('?') {
                    Some(g) => (chosen, g),
                    None => continue,
                }
            }
        };

        // Jitter belongs to the face actually drawing the glyph, so a bouncy
        // face stays bouncy even where it borrows a pictograph from another.
        // Keyed on position in the string rather than on the character, or
        // every 'l' in "hello" would bounce to the same height and the effect
        // would read as a typesetting fault instead of as handwriting.
        let dy = if drawn.jitter.is_empty() {
            0
        } else {
            drawn.jitter[i % drawn.jitter.len()] as isize
        };

        for r in 0..GLYPH_ROWS {
            let y = r as isize + dy;
            if y < 0 || y >= GLYPH_ROWS as isize {
                continue;
            }
            let bits = glyph.rows[r];
            // The whole ink field, not just the advance: a glyph is allowed to
            // overhang its neighbour, which is how an italic tail or a wide
            // accent works. Anything past the end of the grid is clipped.
            for x in 0..GLYPH_FIELD {
                if (bits >> (GLYPH_FIELD - 1 - x)) & 1 == 1 {
                    if let Some(cell) = rows[y as usize].get_mut(pen + x) {
                        *cell = true;
                    }
                }
            }
        }
        pen += glyph.advance as usize;
    }

    Layout {
        rows,
        width,
        missing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serif() -> &'static Face {
        face("serif").unwrap()
    }

    #[test]
    fn faces_are_sorted_for_binary_search() {
        for f in FACES {
            assert!(
                f.glyphs.windows(2).all(|w| w[0].0 < w[1].0),
                "{} must be sorted and unique",
                f.id
            );
        }
    }

    #[test]
    fn face_ids_are_unique() {
        for (i, a) in FACES.iter().enumerate() {
            assert!(
                !FACES[i + 1..].iter().any(|b| b.id == a.id),
                "duplicate face id {}",
                a.id
            );
        }
    }

    #[test]
    fn renders_known_glyphs() {
        let l = layout(serif(), "HI");
        assert_eq!(l.width, 16);
        assert!(l.missing.is_empty());
        // 'H' row 5 is the crossbar: 7 lit pixels then the spacing column.
        let ink: String = l.rows[5][..8].iter().map(|p| if *p { '#' } else { '.' }).collect();
        assert_eq!(ink, "#######.");
    }

    #[test]
    fn unmapped_chars_fall_back_and_are_reported() {
        let l = layout(serif(), "A\u{5b57}");
        assert_eq!(l.width, 16, "the fallback still occupies its width");
        assert_eq!(l.missing, vec!['\u{5b57}']);
    }

    /// The editor budgets typing against `measure` but stamps with `layout`.
    /// If the two disagree, the editor lets someone type a string that will not
    /// fit, which is the failure the measuring API exists to prevent.
    /// A face kept out of the picker has to be earning its place in the
    /// fallback chain instead, which means pictographs rather than letters.
    #[test]
    fn unpickable_faces_carry_no_letters() {
        for f in FACES.iter().filter(|f| !f.pickable) {
            assert!(
                !f.glyphs.iter().any(|(c, _)| c.is_alphabetic()),
                "{} has letters but is not offered in the picker",
                f.id
            );
        }
        assert!(FACES.iter().any(|f| f.pickable), "nothing to pick");
    }

    #[test]
    fn variation_selectors_take_no_room() {
        let f = serif();
        // Emoji arrive from a phone as the pictograph plus U+FE0F.
        assert_eq!(measure(f, "A\u{FE0F}"), measure(f, "A"));
        let l = layout(f, "A\u{FE0F}");
        assert!(l.missing.is_empty(), "the selector must not read as unknown");
    }


    /// Every face you can select has to cover the same characters.
    ///
    /// Otherwise a face silently borrows from another for whatever it lacks,
    /// and the borrowed glyph arrives in the wrong weight and the wrong width:
    /// a Russian or French word rendered half in one face and half in another.
    /// The fallback chain is there for pictographs, not for filling holes in
    /// an alphabet.
    #[test]
    fn pickable_faces_cover_the_same_characters() {
        let pick: Vec<_> = FACES.iter().filter(|f| f.pickable).collect();
        let base: Vec<char> = pick[0].glyphs.iter().map(|(c, _)| *c).collect();
        for f in &pick[1..] {
            let got: Vec<char> = f.glyphs.iter().map(|(c, _)| *c).collect();
            let missing: Vec<char> = base.iter().copied().filter(|c| !got.contains(c)).collect();
            let extra: Vec<char> = got.iter().copied().filter(|c| !base.contains(c)).collect();
            assert!(
                missing.is_empty() && extra.is_empty(),
                "{} vs {}: missing {missing:?}, extra {extra:?}",
                f.id,
                pick[0].id
            );
        }
    }


    #[test]
    fn measure_matches_layout() {
        for f in FACES {
            for s in [
                "",
                " ",
                "HI",
                "Badge Studio",
                "A\u{5b57}",
                "\u{5b57}\u{5b57}\u{5b57}",
                "!@#$%^&*()",
                "the quick brown fox",
            ] {
                assert_eq!(measure(f, s), layout(f, s).width, "{} on {s:?}", f.id);
            }
        }
    }

    #[test]
    fn every_glyph_has_an_advance() {
        for f in FACES {
            assert!(
                f.glyphs.iter().all(|(_, g)| g.advance > 0),
                "{} has a zero-width glyph",
                f.id
            );
            // Only a face you can select needs one: '?' is what an unknown
            // character stamps as, and a fallback-only face is never the one
            // doing the choosing.
            if f.pickable {
                assert!(f.glyph('?').is_some(), "{} needs '?' to fall back on", f.id);
            }
        }
    }

}
