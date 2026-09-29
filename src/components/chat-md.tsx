/**
 * ChatMd — lean, gorgeous markdown for the home chat bubbles.
 *
 * A distilled cut of the Hermes page's ChatMarkdown (same design language,
 * same inline grammar) without the Hermes-specific MoA/init handling:
 * headings, lists, blockquotes, fenced code (with diff coloring), rules,
 * and inline `code` / **bold** / *italic* / links.
 */
import type { ReactNode } from "react";

const CREAM = "var(--foreground)";
const MD_MONO = "var(--font-mono)";

// Inline: `code`, **bold**, *italic*, [text](url), bare urls.
function mdInline(s: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re =
    /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const linkStyle = {
    color: "var(--brand)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklab, var(--brand) 45%, transparent)",
    textUnderlineOffset: 2,
  } as const;
  // Orphan "**" (pair broken across a block boundary) reads as broken output —
  // strip from display.
  const plain = (t: string) => t.replace(/\*\*/g, "");
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(plain(s.slice(last, m.index)));
    if (m[2] !== undefined) {
      parts.push(
        <code
          key={`${keyBase}-c${i}`}
          style={{
            fontFamily: MD_MONO,
            fontSize: "12.5px",
            background: "color-mix(in oklab, var(--foreground) 12%, transparent)",
            color: CREAM,
            padding: "1px 5px",
            borderRadius: 4,
          }}
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <strong key={`${keyBase}-b${i}`} style={{ color: CREAM, fontWeight: 650 }}>
          {m[3]}
        </strong>,
      );
    } else if (m[4] !== undefined) {
      parts.push(
        <em key={`${keyBase}-i${i}`} style={{ color: "var(--foreground)" }}>
          {m[4]}
        </em>,
      );
    } else if (m[5] !== undefined && m[6] !== undefined) {
      parts.push(
        <a key={`${keyBase}-a${i}`} href={m[6]} target="_blank" rel="noreferrer" style={linkStyle}>
          {m[5]}
        </a>,
      );
    } else if (m[7] !== undefined) {
      const url = m[7].replace(/[.,;:!?]+$/, "");
      const trail = m[7].slice(url.length);
      parts.push(
        <a key={`${keyBase}-u${i}`} href={url} target="_blank" rel="noreferrer" style={linkStyle}>
          {url}
        </a>,
      );
      if (trail) parts.push(trail);
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < s.length) parts.push(plain(s.slice(last)));
  return parts;
}

function CodeCard({ lang, code, k }: { lang: string; code: string; k: string }) {
  const isDiff = lang === "diff" || /^(diff --git|@@ )/m.test(code);
  return (
    <div
      key={k}
      style={{
        margin: "10px 0",
        border: "1px solid color-mix(in oklab, var(--foreground) 20%, transparent)",
        borderRadius: 10,
        background: "var(--inset)",
        overflow: "hidden",
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 12,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "color-mix(in oklab, var(--brand) 75%, transparent)",
          padding: "5px 12px",
          borderBottom: "1px solid color-mix(in oklab, var(--foreground) 12%, transparent)",
          background: "color-mix(in oklab, var(--foreground) 4%, transparent)",
        }}
      >
        {isDiff ? "diff" : lang || "code"}
      </div>
      <div
        style={{
          overflowX: "auto",
          padding: "8px 0",
          fontFamily: MD_MONO,
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {code.split("\n").map((l, j) => {
          const isFile = isDiff && /^(diff --git|[+]{3}\s|-{3}\s|index\s)/.test(l);
          const isHunk = isDiff && /^@@/.test(l);
          const isAdd = isDiff && !isFile && l.startsWith("+");
          const isDel = isDiff && !isFile && l.startsWith("-");
          return (
            <div
              key={j}
              style={{
                padding: "0 12px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: isFile
                  ? CREAM
                  : isHunk
                    ? "color-mix(in oklab, var(--brand) 80%, transparent)"
                    : isAdd
                      ? "var(--success)"
                      : isDel
                        ? "var(--danger)"
                        : "color-mix(in oklab, var(--foreground) 85%, transparent)",
                background: isAdd
                  ? "color-mix(in oklab, var(--success) 7%, transparent)"
                  : isDel
                    ? "color-mix(in oklab, var(--danger) 6%, transparent)"
                    : "transparent",
                fontWeight: isFile ? 600 : 400,
              }}
            >
              {l || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChatMd({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let seq = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const key = `b${i}-${seq++}`;

    // fenced code
    const fence = line.match(/^```\s*(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trimEnd())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(<CodeCard key={key} lang={lang} code={buf.join("\n")} k={key} />);
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push(
        <div key={key} style={{ height: 1, background: "color-mix(in oklab, var(--foreground) 15%, transparent)", margin: "12px 0" }} />,
      );
      i++;
      continue;
    }

    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const depth = h[1].length;
      blocks.push(
        <div
          key={key}
          style={{
            fontWeight: 650,
            color: CREAM,
            fontSize: depth === 1 ? 17 : depth === 2 ? 15.5 : 14,
            margin: `${depth === 1 ? 14 : 10}px 0 4px`,
            ...(depth <= 2
              ? { borderBottom: "1px solid color-mix(in oklab, var(--foreground) 14%, transparent)", paddingBottom: 4 }
              : {}),
          }}
        >
          {mdInline(h[2], key)}
        </div>,
      );
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trimEnd())) {
        buf.push(lines[i].trimEnd().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <div
          key={key}
          style={{
            borderLeft: "2px solid color-mix(in oklab, var(--brand) 50%, transparent)",
            padding: "2px 0 2px 12px",
            margin: "8px 0",
            color: "color-mix(in oklab, var(--foreground) 75%, transparent)",
            fontStyle: "italic",
          }}
        >
          {buf.map((b, j) => (
            <div key={j}>{mdInline(b, `${key}-q${j}`)}</div>
          ))}
        </div>,
      );
      continue;
    }

    // lists (bullet + numbered, one level of nesting)
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: Array<{ marker: string; text: string; indent: number }> = [];
      while (i < lines.length) {
        const l = lines[i].trimEnd();
        const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push({ indent: m[1].length >= 2 ? 1 : 0, marker: m[2], text: m[3] });
        i++;
      }
      blocks.push(
        <div key={key} style={{ margin: "6px 0", display: "flex", flexDirection: "column", gap: 3 }}>
          {items.map((it, j) => (
            <div
              key={j}
              style={{ display: "flex", gap: 8, paddingLeft: it.indent ? 18 : 0, alignItems: "baseline" }}
            >
              <span
                className="font-mono"
                style={{
                  color: "color-mix(in oklab, var(--brand) 75%, transparent)",
                  fontSize: /\d/.test(it.marker) ? 11.5 : 13,
                  flexShrink: 0,
                  minWidth: /\d/.test(it.marker) ? 16 : "auto",
                }}
              >
                {/\d/.test(it.marker) ? it.marker.replace(")", ".") : "•"}
              </span>
              <span style={{ minWidth: 0 }}>{mdInline(it.text, `${key}-l${j}`)}</span>
            </div>
          ))}
        </div>,
      );
      continue;
    }

    // blank line → spacing
    if (!line.trim()) {
      blocks.push(<div key={key} style={{ height: 7 }} />);
      i++;
      continue;
    }

    // paragraph
    blocks.push(
      <div key={key} style={{ margin: "1px 0" }}>
        {mdInline(line, key)}
      </div>,
    );
    i++;
  }

  return <div style={{ wordBreak: "break-word" }}>{blocks}</div>;
}
