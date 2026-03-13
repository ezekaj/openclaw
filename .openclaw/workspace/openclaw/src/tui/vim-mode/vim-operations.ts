/**
 * Vim Operations
 *
 * Implements Vim text operations (move, delete, etc.)
 */

import type { CustomEditor } from "../components/custom-editor.js";
import type { VimOperationResult } from "./types.js";

/**
 * Vim operations class
 */
export class VimOperations {
  private editor: CustomEditor;

  constructor(editor: CustomEditor) {
    this.editor = editor;
  }

  // ============================================================================
  // CURSOR MOVEMENT
  // ============================================================================

  /**
   * Move cursor left (h)
   */
  moveLeft(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    if (pos.column > 0) {
      this.editor.setCursorPosition(pos.line, pos.column - 1);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Move cursor right (l)
   */
  moveRight(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const line = this.editor.getLine(pos.line);
    if (pos.column < line.length) {
      this.editor.setCursorPosition(pos.line, pos.column + 1);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Move cursor up (k)
   */
  moveUp(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    if (pos.line > 0) {
      this.editor.setCursorPosition(pos.line - 1, pos.column);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Move cursor down (j)
   */
  moveDown(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const totalLines = this.editor.getLineCount();
    if (pos.line < totalLines - 1) {
      this.editor.setCursorPosition(pos.line + 1, pos.column);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Move to start of line (0)
   */
  moveToLineStart(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    this.editor.setCursorPosition(pos.line, 0);
    return { success: true };
  }

  /**
   * Move to end of line ($)
   */
  moveToLineEnd(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const line = this.editor.getLine(pos.line);
    this.editor.setCursorPosition(pos.line, line.length);
    return { success: true };
  }

  /**
   * Move to first non-blank character (^)
   */
  moveToFirstNonBlank(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const line = this.editor.getLine(pos.line);
    const column = this.findFirstNonBlank(line);
    this.editor.setCursorPosition(pos.line, column);
    return { success: true };
  }

  /**
   * Move to first line (gg)
   */
  moveToFirstLine(): VimOperationResult {
    this.editor.setCursorPosition(0, 0);
    return { success: true };
  }

  /**
   * Move to last line (G)
   */
  moveToLastLine(): VimOperationResult {
    const lastLine = this.editor.getLineCount() - 1;
    this.editor.setCursorPosition(lastLine, 0);
    return { success: true };
  }

  /**
   * Move to next word (w)
   */
  moveToNextWord(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const lineCount = this.editor.getLineCount();
    let currentLine = pos.line;
    let currentCol = pos.column;

    // Try to find next word on current line
    const line = this.editor.getLine(currentLine);
    
    // Skip current word characters
    while (currentCol < line.length && this.isWordChar(line[currentCol])) {
      currentCol++;
    }
    
    // Skip non-word characters (punctuation, whitespace)
    while (currentCol < line.length && !this.isWordChar(line[currentCol])) {
      currentCol++;
    }

    // If found a word character on current line
    if (currentCol < line.length) {
      this.editor.setCursorPosition(currentLine, currentCol);
      return { success: true };
    }

    // Move to next line and find first word
    while (currentLine < lineCount - 1) {
      currentLine++;
      const nextLine = this.editor.getLine(currentLine);
      const firstWordCol = this.findFirstNonBlank(nextLine);
      if (firstWordCol < nextLine.length) {
        this.editor.setCursorPosition(currentLine, firstWordCol);
        return { success: true };
      }
    }

    return { success: false };
  }

  /**
   * Move to previous word (b)
   */
  moveToPrevWord(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    let currentLine = pos.line;
    let currentCol = pos.column;

    // Try to find previous word on current line
    const line = this.editor.getLine(currentLine);
    
    // If at start of line, go to previous line
    if (currentCol === 0) {
      if (currentLine === 0) {
        return { success: false };
      }
      currentLine--;
      const prevLine = this.editor.getLine(currentLine);
      const wordStart = this.findLastWordStart(prevLine);
      this.editor.setCursorPosition(currentLine, wordStart);
      return { success: true };
    }

    // Move back past any non-word characters
    while (currentCol > 0 && !this.isWordChar(line[currentCol - 1])) {
      currentCol--;
    }

    // Move back to start of word
    while (currentCol > 0 && this.isWordChar(line[currentCol - 1])) {
      currentCol--;
    }

    // If we found a word start
    if (currentCol !== pos.column && this.isWordChar(line[currentCol])) {
      this.editor.setCursorPosition(currentLine, currentCol);
      return { success: true };
    }

    // Move to previous line
    if (currentLine > 0) {
      currentLine--;
      const prevLine = this.editor.getLine(currentLine);
      const wordStart = this.findLastWordStart(prevLine);
      this.editor.setCursorPosition(currentLine, wordStart);
      return { success: true };
    }

    return { success: false };
  }

  /**
   * Move to end of word (e)
   */
  moveToEndWord(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const lineCount = this.editor.getLineCount();
    let currentLine = pos.line;
    let currentCol = pos.column;

    // Try to find end of word on current line
    const line = this.editor.getLine(currentLine);
    
    // Move past current character if on a word
    if (currentCol < line.length && this.isWordChar(line[currentCol])) {
      currentCol++;
    }

    // Skip non-word characters
    while (currentCol < line.length && !this.isWordChar(line[currentCol])) {
      currentCol++;
    }

    // If at end of line, move to next line
    if (currentCol >= line.length) {
      while (currentLine < lineCount - 1) {
        currentLine++;
        const nextLine = this.editor.getLine(currentLine);
        const wordEnd = this.findFirstWordEnd(nextLine);
        if (wordEnd >= 0) {
          this.editor.setCursorPosition(currentLine, wordEnd);
          return { success: true };
        }
      }
      return { success: false };
    }

    // Move to end of word
    while (currentCol < line.length - 1 && this.isWordChar(line[currentCol + 1])) {
      currentCol++;
    }

    this.editor.setCursorPosition(currentLine, currentCol);
    return { success: true };
  }

  // ============================================================================
  // TEXT OPERATIONS
  // ============================================================================

  /**
   * Delete character under cursor (x)
   */
  deleteChar(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const line = this.editor.getLine(pos.line);
    if (pos.column < line.length) {
      const newText = line.slice(0, pos.column) + line.slice(pos.column + 1);
      this.editor.setLine(pos.line, newText);
      return { success: true };
    }
    return { success: false };
  }

  /**
   * Delete line (dd)
   */
  deleteLine(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    const totalLines = this.editor.getLineCount();

    if (totalLines === 1) {
      this.editor.setText("");
      return { success: true };
    }

    this.editor.removeLine(pos.line);

    // Move cursor to previous line if deleted last line
    if (pos.line >= totalLines - 1) {
      this.editor.setCursorPosition(pos.line - 1, 0);
    } else {
      this.editor.setCursorPosition(pos.line, 0);
    }

    return { success: true };
  }

  /**
   * Insert mode (i)
   */
  enterInsertMode(): VimOperationResult {
    return { success: true, mode: "INSERT" };
  }

  /**
   * Append mode (a)
   */
  enterAppendMode(): VimOperationResult {
    this.moveRight();
    return { success: true, mode: "INSERT" };
  }

  /**
   * Insert at line start (I)
   */
  enterInsertAtLineStart(): VimOperationResult {
    this.moveToFirstNonBlank();
    return { success: true, mode: "INSERT" };
  }

  /**
   * Append at line end (A)
   */
  enterAppendAtLineEnd(): VimOperationResult {
    this.moveToLineEnd();
    return { success: true, mode: "INSERT" };
  }

  /**
   * Open line below (o)
   */
  openLineBelow(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    this.editor.insertLine(pos.line + 1, "");
    this.editor.setCursorPosition(pos.line + 1, 0);
    return { success: true, mode: "INSERT" };
  }

  /**
   * Open line above (O)
   */
  openLineAbove(): VimOperationResult {
    const pos = this.editor.getCursorPosition();
    this.editor.insertLine(pos.line, "");
    this.editor.setCursorPosition(pos.line, 0);
    return { success: true, mode: "INSERT" };
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Check if character is a word character
   */
  private isWordChar(char: string): boolean {
    return /\w/.test(char);
  }

  /**
   * Find the column of the first non-blank character in a line
   */
  private findFirstNonBlank(line: string): number {
    const match = line.match(/\S/);
    return match?.index ?? 0;
  }

  /**
   * Find the start column of the last word in a line
   */
  private findLastWordStart(line: string): number {
    // Find last word character
    let end = line.length - 1;
    while (end >= 0 && !this.isWordChar(line[end])) {
      end--;
    }
    if (end < 0) {
      return 0; // No words found
    }
    // Find start of that word
    let start = end;
    while (start > 0 && this.isWordChar(line[start - 1])) {
      start--;
    }
    return start;
  }

  /**
   * Find the end column of the first word in a line
   * @returns column of word end, or -1 if no word found
   */
  private findFirstWordEnd(line: string): number {
    // Find first word character
    let col = 0;
    while (col < line.length && !this.isWordChar(line[col])) {
      col++;
    }
    if (col >= line.length) {
      return -1; // No word found
    }
    // Find end of that word
    while (col < line.length - 1 && this.isWordChar(line[col + 1])) {
      col++;
    }
    return col;
  }
}

/**
 * Create Vim operations instance
 */
export function createVimOperations(editor: CustomEditor): VimOperations {
  return new VimOperations(editor);
}
