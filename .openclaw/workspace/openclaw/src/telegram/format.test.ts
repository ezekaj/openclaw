import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("renders basic inline formatting", () => {
    const res = markdownToTelegramHtml("hi _there_ **boss** `code`");
    expect(res).toBe("hi <i>there</i> <b>boss</b> <code>code</code>");
  });

  it("renders links as Telegram-safe HTML", () => {
    const res = markdownToTelegramHtml("see [docs](https://example.com)");
    expect(res).toBe('see <a href="https://example.com">docs</a>');
  });

  it("escapes raw HTML", () => {
    const res = markdownToTelegramHtml("<b>nope</b>");
    expect(res).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("escapes unsafe characters", () => {
    const res = markdownToTelegramHtml("a & b < c");
    expect(res).toBe("a &amp; b &lt; c");
  });

  it("renders paragraphs with blank lines", () => {
    const res = markdownToTelegramHtml("first\n\nsecond");
    expect(res).toBe("first\n\nsecond");
  });

  it("renders lists without block HTML", () => {
    const res = markdownToTelegramHtml("- one\n- two");
    expect(res).toBe("• one\n• two");
  });

  it("renders ordered lists with numbering", () => {
    const res = markdownToTelegramHtml("2. two\n3. three");
    expect(res).toBe("2. two\n3. three");
  });

  it("flattens headings and blockquotes", () => {
    const res = markdownToTelegramHtml("# Title\n\n> Quote");
    expect(res).toBe("Title\n\nQuote");
  });

  it("renders fenced code blocks", () => {
    const res = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("rejects javascript: scheme in links (XSS protection)", () => {
    const res = markdownToTelegramHtml("[click](javascript:alert(1))");
    // markdown-it blocks javascript: by default, but we also validate in buildTelegramLink
    expect(res).toBe("click");
  });

  it("rejects data: scheme in links (XSS protection)", () => {
    const res = markdownToTelegramHtml("[click](data:text/html,<script>alert(1)</script>)");
    expect(res).toBe("click");
  });

  it("rejects vbscript: scheme in links (XSS protection)", () => {
    const res = markdownToTelegramHtml("[click](vbscript:msgbox(1))");
    expect(res).toBe("click");
  });

  it("allows safe URL schemes", () => {
    const https = markdownToTelegramHtml("[link](https://example.com)");
    expect(https).toBe('<a href="https://example.com">link</a>');

    const http = markdownToTelegramHtml("[link](http://example.com)");
    expect(http).toBe('<a href="http://example.com">link</a>');

    const mailto = markdownToTelegramHtml("[email](mailto:test@example.com)");
    expect(mailto).toBe('<a href="mailto:test@example.com">email</a>');

    const tel = markdownToTelegramHtml("[phone](tel:+1234567890)");
    expect(tel).toBe('<a href="tel:+1234567890">phone</a>');
  });

  it("handles empty markdown input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
    expect(markdownToTelegramHtml(null as unknown as string)).toBe("");
    expect(markdownToTelegramHtml(undefined as unknown as string)).toBe("");
  });
});
