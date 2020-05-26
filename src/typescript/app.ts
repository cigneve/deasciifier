/// <reference path="./common.ts" />
/// <reference path="./deasciifier.ts" />
/// <reference path="./correction_menu.ts" />

import {
  TextRange, Position, TextProcessor, TextProcessingOptions,
  TextResult, KeyCode
} from "./common"
import { Deasciifier, Asciifier } from "./deasciifier"
import { CorrectionCallback, CorrectionMenu } from "./correction_menu"
import { KeyboardCallback, Keyboard } from "./keyboard"
import { TextHelper } from "./text_helper"
import { DomElementImpl, DomFactoryImpl } from "./dom";
import { DomFactory, DomElement } from "./view";
import { KeyboardLayout } from "./keyboard_layout_turkish"

class Options {
  public constructor(public highlightChanges: boolean,
    public enableCorrectionMenu: boolean,
    public enableAutoConvert: boolean) { }
}

interface TextEditor {
  getText(): string;
  setText(text: string, range?: TextRange): void;

  getSelection(): TextRange;
  setSelection(range: TextRange): void;

  highlight(range: TextRange, cssName: string): any;
  // Use this for multiple markers.
  highlightMultiple(ranges: TextRange[], cssName: string): void;

  clearHighlights(range: TextRange): void;

  // Returns absolute coordinates of the character at |index|.
  getPosition(index: number): Position;
  // Returns the line height in pixel.
  getLineHeight(): number;

  // Simulates typing |text| at the cursor position.
  putAtCursor(text: string): void;
  // Simulates pressing backspace key at the cursor position.
  deleteCursor(): void;

  // Set focus to the editor.
  focus(): void;
}

interface TextEditorEventListener {
  onKeyUp(keyCode: number): void;
  onClick(): void;
}

class CodeMirrorEditor implements TextEditor {
  constructor(
    private editor: any, private eventListener: TextEditorEventListener) {
    editor.getWrapperElement().onkeyup = function (e: any) {
      eventListener.onKeyUp(e.keyCode);
    }
    editor.getWrapperElement().onclick = function (e: any) {
      eventListener.onClick();
    }
  }

  public setText(text: string, range?: TextRange) {
    if (range) {
      let rangeStart = this.editor.posFromIndex(range.start);
      let rangeEnd = this.editor.posFromIndex(range.end);
      this.editor.replaceRange(text, rangeStart, rangeEnd);
    } else {
      this.editor.setValue(text);
    }
  }

  public getText(): string {
    return this.editor.getValue();
  }

  public getSelection(): TextRange {
    let start = this.editor.indexFromPos(this.editor.getCursor(true));
    let end = this.editor.indexFromPos(this.editor.getCursor(false));
    return new TextRange(start, end);
  }

  public setSelection(range: TextRange) {
    let rangeStart = this.editor.posFromIndex(range.start);
    let rangeEnd = this.editor.posFromIndex(range.end);
    this.editor.setSelection(rangeStart, rangeEnd);
  }

  public highlight(range: TextRange, cssName: string) {
    let rangeStart = this.editor.posFromIndex(range.start);
    let rangeEnd = this.editor.posFromIndex(range.end);
    return this.editor.markText(
      rangeStart, rangeEnd,
      { readOnly: false, className: cssName });
  }

  public highlightMultiple(ranges: TextRange[], cssName: string) {
    let self = this;
    this.editor.operation(function () {
      for (let range of ranges) {
        self.highlight(range, cssName);
      }
    });
  }

  public clearHighlights(range: TextRange) {
    let rangeStart = this.editor.posFromIndex(range.start);
    let rangeEnd = this.editor.posFromIndex(range.end);
    let marks = this.editor.findMarks(rangeStart, rangeEnd);
    for (let mark of marks) {
      mark.clear();
    }
  }

  public getPosition(index: number): Position {
    let linech = this.editor.posFromIndex(index);
    let coords = this.editor.charCoords(linech);
    return <Position>{ left: coords.left, top: coords.top };
  }

  public getLineHeight(): number {
    return this.editor.defaultTextHeight();
  }

  public putAtCursor(text: string) {
    let selection = this.getSelection();
    this.setText(text, selection);
  }

  public deleteCursor(): void {
    this.editor.execCommand("delCharBefore");
  }

  public focus(): void {
    this.editor.focus();
  }
}

enum TextProcessorMode {
  DEASCIIFY,
  ASCIIFY
}

class DeasciifyProcessor implements TextProcessor {
  private processor: TextProcessor;
  constructor(
    private deasciifier: Deasciifier, private asciifier: Asciifier) {
    this.processor = deasciifier;
  }

  public setMode(mode: TextProcessorMode) {
    if (mode == TextProcessorMode.DEASCIIFY)
      this.processor = this.deasciifier;
    else
      this.processor = this.asciifier;
  }

  public processRange(
    text: string, range: TextRange,
    options: TextProcessingOptions): TextResult {
    return this.processor.processRange(text, range, options);
  }

  public process(text: string, options: TextProcessingOptions): TextResult {
    return this.processor.process(text, options);
  }
}

class CorrectionCallbackImpl implements CorrectionCallback {
  constructor(private box: DeasciiBox) { }
  onchange(text: string) {
    this.box.oncorrectiontextchange(text);
  }
}

class DeasciiBox {
  private options_: Options;
  private correctionMenu: CorrectionMenu;
  private correctionMenuSelection: TextRange;
  private correctionMenuHighlight: any;

  constructor(
    parent: DomElement,
    domFactory: DomFactory,
    private textEditor: TextEditor,
    private textProcessor: DeasciifyProcessor) {
    this.options_ = new Options(true, true, true);
    this.correctionMenuSelection = null;

    let correctionElement = domFactory.createDiv();
    this.correctionMenu =
      new CorrectionMenu(correctionElement, new CorrectionCallbackImpl(this), domFactory);
    parent.appendChild(correctionElement);
  }

  public oncorrectiontextchange(text: string) {
    this.textEditor.setText(text, this.correctionMenuSelection);
  }

  public onKeyUp(keyCode: number) {
    if (!this.options_.enableAutoConvert) {
      return;
    }
    if (TextHelper.isSeparatorChar(String.fromCharCode(keyCode))) {
      this.deasciifyCursor();
    }
  }

  public onClick() {
    this.hideCorrectionMenu();
    if (!this.options_.enableCorrectionMenu) {
      return;
    }

    let selectionRange = this.textEditor.getSelection();
    // Since this is a mouse up event, we expect start and end positions
    // to be the same. TODO: Is this always the case?
    if (selectionRange.start != selectionRange.end) {
      throw new Error("Unexpected condition");
    }
    let cursorPos = selectionRange.start;
    let text: string = this.textEditor.getText();
    // Only show the menu if we are in the middle of a word
    if (!TextHelper.isCursorInsideWord(text, cursorPos)) {
      return;
    }
    let wordBoundary = TextHelper.getWordAtCursor(text, cursorPos);
    let wordText = text.substring(wordBoundary.start, wordBoundary.end);

    // Don't show menu if there is nothing to suggest
    if (!CorrectionMenu.hasCorrections(wordText)) {
      return;
    }

    let startCoords = this.textEditor.getPosition(wordBoundary.start);
    let endCoords = this.textEditor.getPosition(wordBoundary.end);

    let middleX = (startCoords.left + endCoords.left) / 2;
    let menuCoords = <Position>{
      left: middleX,
      top: startCoords.top + this.textEditor.getLineHeight()
    }

    this.correctionMenuSelection = wordBoundary;
    this.correctionMenu.show(menuCoords, wordText);
    this.correctionMenuHighlight =
      this.textEditor.highlight(wordBoundary, "correction-menu-selection");
  }

  private deasciifyCursor() {
    let selectionRange = this.textEditor.getSelection();
    let rangeToDeasciify: TextRange = null;
    let text = this.textEditor.getText();
    if (selectionRange.start == selectionRange.end) {
      // No text selected. Get the boundaries of the last word that is
      // separated by space, enter etc.
      rangeToDeasciify =
        TextHelper.getWordBeforeCursor(text, selectionRange.start);
    } else {
      // A portion of the text is already selected. Deasciify only the
      // selected part.
      rangeToDeasciify = selectionRange;
    }
    // Deasciify the range.
    let result =
      this.textProcessor.processRange(text, rangeToDeasciify, null);
    // Highlight the results.
    this.displayResult(result);
    // Restore cursor.
    this.textEditor.setSelection(selectionRange);
  }

  /** Displays the conversion results in the textbox and highlights the
   * converted characters if necessary.
   */
  private displayResult(result: TextResult) {
    if (result && result.text) {
      this.textEditor.setText(result.text);
      this.highlightChanges(result.changedPositions, false);
    }
  }

  private highlightChanges(
    changedPositions: Array<number>, forceClear: boolean) {
    // Highlight results.
    if (!this.options_.highlightChanges) {
      return;
    }
    if ((!changedPositions || changedPositions.length == 0) && !forceClear) {
      return;
    }
    //this.textEditor.clearHighlights();
    let ranges: TextRange[] = [];
    for (let i = 0; i < changedPositions.length; i++) {
      ranges.push(new TextRange(changedPositions[i], changedPositions[i] + 1));
    }
    this.textEditor.highlightMultiple(ranges, "deasciifier-highlight");
  }

  public hideCorrectionMenu() {
    this.correctionMenu.hide();
    if (this.correctionMenuSelection) {
      this.textEditor.clearHighlights(this.correctionMenuSelection);
    }
    if (this.correctionMenuHighlight) {
      this.correctionMenuHighlight.clear();
    }
  }

  public processSelection(mode: TextProcessorMode) {
    let range = this.textEditor.getSelection();
    if (range.start == range.end) {
      range = <TextRange>{ start: 0, end: this.textEditor.getText().length };
    }
    this.textProcessor.setMode(mode);
    let result =
      this.textProcessor.processRange(this.textEditor.getText(), range, null);
    this.textEditor.setText(
      result.text.substring(range.start, range.end), range);
    this.highlightChanges(result.changedPositions, false);
    return result;
  }

  public setEnableCorrectionMenu(enabled: boolean) {
    if (!enabled) {
      this.hideCorrectionMenu();
    }
    this.options_.enableCorrectionMenu = enabled;
  }

  public setEnableAutoConvert(enabled: boolean) {
    this.options_.enableAutoConvert = enabled;
  }
}

class KeyboardHandler implements KeyboardCallback {
  constructor(private app: App, private editor: TextEditor) { }
  onKey(key: string) {
    this.app.hideCorrectionMenu();
    this.editor.focus();
    if (key == "backspace") {
      this.editor.deleteCursor();
      return;
    }
    this.editor.putAtCursor(key);
  }
}

// The actual app.
export class App implements TextEditorEventListener {
  private textEditor: TextEditor;
  private deasciiBox: DeasciiBox;
  private keyboardHandler: KeyboardHandler;
  private deasciifier_instance: Deasciifier;
  private asciifier_instance: Asciifier;
  private keyboard: Keyboard;

  constructor(
    codemirror: any,
    pattern_list: any,
    parentContainer: HTMLElement,
    keyboardContainer: HTMLElement,
    domFactory: DomFactory = new DomFactoryImpl()) {

    this.deasciifier_instance = new Deasciifier();
    this.deasciifier_instance.init(pattern_list);
    this.asciifier_instance = new Asciifier();

    let parent: DomElement = new DomElementImpl(parentContainer);
    this.textEditor = new CodeMirrorEditor(codemirror, this);
    this.deasciiBox =
      new DeasciiBox(
        parent,
        domFactory,
        this.textEditor,
        new DeasciifyProcessor(
          this.deasciifier_instance, this.asciifier_instance));

    let keyboard_container = new DomElementImpl(keyboardContainer);
    this.keyboard = new Keyboard(
      KeyboardLayout['TR_Q'],
      keyboard_container, domFactory);
    parent.appendChild(keyboard_container);

    this.keyboardHandler = new KeyboardHandler(this, this.textEditor);
    this.keyboard.create(this.keyboardHandler);
  }

  public deasciifySelection() {
    return this.deasciiBox.processSelection(TextProcessorMode.DEASCIIFY);
  }

  public asciifySelection() {
    return this.deasciiBox.processSelection(TextProcessorMode.ASCIIFY);
  }

  public hideCorrectionMenu() {
    this.deasciiBox.hideCorrectionMenu();
  }

  public onKeyUp(keyCode: number) {
    this.deasciiBox.onKeyUp(keyCode);
  }

  public onClick() {
    this.deasciiBox.onClick();
  }

  public setEnableCorrectionMenu(enabled: boolean) {
    this.deasciiBox.setEnableCorrectionMenu(enabled);
  }

  public setEnableAutoConvert(enabled: boolean) {
    this.deasciiBox.setEnableAutoConvert(enabled);
  }
}
