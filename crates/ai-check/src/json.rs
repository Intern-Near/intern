//! A small, strict JSON reader (RFC 8259) for the request and response bodies.
//!
//! Why its own reader: a tolerant parser can read two different texts as the same thing, and NEAR AI's server and
//! this program must not disagree about what the model was sent. So anything a careful reader could take two ways
//! is refused:
//! - a key that appears twice in one object (servers often keep the last one; this reader refuses the body);
//! - text that is not valid UTF-8, a raw control character in a string, a lone surrogate in a `\u` escape;
//! - anything outside the grammar: comments, trailing commas, `NaN`, single quotes, a byte-order mark, leading
//!   zeros in numbers, text after the value.
//!
//! Escapes are decoded (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX` including surrogate pairs), so a
//! string is compared by the text it stands for, which is what the model read. Numbers are checked against the
//! grammar and kept as text: nothing here needs their value.
//!
//! It never panics, and its work grows linearly with the input: nesting is limited to `MAX_DEPTH`, and an object
//! to `MAX_KEYS` keys (the duplicate check compares each key with the ones before it).

use alloc::string::String;
use alloc::vec::Vec;

pub const MAX_DEPTH: usize = 64;
pub const MAX_KEYS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    /// The number as written. Its syntax is checked; its value is not computed.
    Number(String),
    Str(String),
    Array(Vec<Value>),
    /// Keys in the order written. No key appears twice.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The value of `key` in an object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }
    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(fields) => Some(fields),
            _ => None,
        }
    }
}

/// Reads one JSON value that fills the whole input (whitespace around it allowed). None for anything else.
pub fn parse(bytes: &[u8]) -> Option<Value> {
    let text = core::str::from_utf8(bytes).ok()?;
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i == p.b.len() {
        Some(v)
    } else {
        None
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Option<()> {
        if self.peek() == Some(c) {
            self.i += 1;
            Some(())
        } else {
            None
        }
    }

    fn literal(&mut self, word: &[u8]) -> Option<()> {
        let end = self.i.checked_add(word.len())?;
        if self.b.get(self.i..end) == Some(word) {
            self.i = end;
            Some(())
        } else {
            None
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        match self.peek()? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string().map(Value::Str),
            b't' => self.literal(b"true").map(|_| Value::Bool(true)),
            b'f' => self.literal(b"false").map(|_| Value::Bool(false)),
            b'n' => self.literal(b"null").map(|_| Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn object(&mut self, depth: usize) -> Option<Value> {
        self.eat(b'{')?;
        self.ws();
        let mut fields: Vec<(String, Value)> = Vec::new();
        if self.eat(b'}').is_some() {
            return Some(Value::Object(fields));
        }
        loop {
            if fields.len() >= MAX_KEYS || self.peek()? != b'"' {
                return None;
            }
            let key = self.string()?;
            if fields.iter().any(|(k, _)| *k == key) {
                return None; // a duplicate key: refused, never "last one wins"
            }
            self.ws();
            self.eat(b':')?;
            self.ws();
            let v = self.value(depth + 1)?;
            fields.push((key, v));
            self.ws();
            match self.peek()? {
                b',' => {
                    self.i += 1;
                    self.ws();
                }
                b'}' => {
                    self.i += 1;
                    return Some(Value::Object(fields));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self, depth: usize) -> Option<Value> {
        self.eat(b'[')?;
        self.ws();
        let mut items = Vec::new();
        if self.eat(b']').is_some() {
            return Some(Value::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek()? {
                b',' => {
                    self.i += 1;
                    self.ws();
                }
                b']' => {
                    self.i += 1;
                    return Some(Value::Array(items));
                }
                _ => return None,
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        let _ = self.eat(b'-');
        match self.peek()? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return None,
        }
        if self.eat(b'.').is_some() && self.digits() == 0 {
            return None;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return None;
            }
        }
        let text = core::str::from_utf8(self.b.get(start..self.i)?).ok()?;
        Some(Value::Number(String::from(text)))
    }

    fn hex4(&mut self) -> Option<u32> {
        let end = self.i.checked_add(4)?;
        let mut v = 0u32;
        for &h in self.b.get(self.i..end)? {
            v = v * 16 + char::from(h).to_digit(16)?;
        }
        self.i = end;
        Some(v)
    }

    fn string(&mut self) -> Option<String> {
        self.eat(b'"')?;
        let mut out = String::new();
        loop {
            // Copy a run of plain characters in one go. It ends at an ASCII byte, so at a character boundary.
            let start = self.i;
            while matches!(self.peek(), Some(c) if c != b'"' && c != b'\\' && c >= 0x20) {
                self.i += 1;
            }
            out.push_str(core::str::from_utf8(self.b.get(start..self.i)?).ok()?);
            match self.peek()? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek()?;
                    self.i += 1;
                    let c = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi) {
                                self.literal(b"\\u")?;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return None;
                                }
                                char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))?
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return None; // a low surrogate on its own
                            } else {
                                char::from_u32(hi)?
                            }
                        }
                        _ => return None,
                    };
                    out.push(c);
                }
                _ => return None, // a raw control character
            }
        }
    }
}
