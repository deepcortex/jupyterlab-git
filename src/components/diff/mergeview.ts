// This code is based on the CodeMirror merge add-on
// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: https://codemirror.net/LICENSE

/* tslint:disable:triple-equals */

import CodeMirror from 'codemirror';

import {
  diff_match_patch,
  DIFF_EQUAL,
  DIFF_DELETE,
  DIFF_INSERT
} from 'diff-match-patch';

export namespace MergeView {
  /**
   * Options available to MergeView.
   */
  export interface IMergeViewEditorConfiguration
    extends CodeMirror.EditorConfiguration {
    /**
     * Determines whether the original editor allows editing. Defaults to false.
     */
    allowEditingOriginals?: boolean;

    /**
     * When true stretches of unchanged text will be collapsed. When a number is given, this indicates the amount
     * of lines to leave visible around such stretches (which defaults to 2). Defaults to false.
     */
    collapseIdentical?: boolean | number;

    /**
     * Sets the style used to connect changed chunks of code. By default, connectors are drawn. When this is set to "align",
     * the smaller chunk is padded to align with the bigger chunk instead.
     */
    connect?: string;

    ignoreWhitespace?: boolean;

    /**
     * Callback for when stretches of unchanged text are collapsed.
     */
    onCollapse?(
      mergeView: IMergeViewEditor,
      line: number,
      size: number,
      mark: CodeMirror.TextMarker
    ): void;

    /**
     * Provides original version of the document to be shown on the right of the editor.
     */
    orig: any;

    /**
     * Provides original version of the document to be shown on the left of the editor.
     * To create a 2-way (as opposed to 3-way) merge view, provide only one of origLeft and origRight.
     */
    origLeft?: any;

    /**
     * Provides original version of document to be shown on the right of the editor.
     * To create a 2-way (as opposed to 3-way) merge view, provide only one of origLeft and origRight.
     */
    origRight?: any;

    /**
     * Determines whether buttons that allow the user to revert changes are shown. Defaults to true.
     */
    revertButtons?: boolean;

    /**
     * When true, changed pieces of text are highlighted. Defaults to true.
     */
    showDifferences?: boolean;
  }

  export interface IMergeViewEditor {
    /**
     * Returns the editor instance.
     */
    editor(): CodeMirror.Editor;

    /**
     * Left side of the merge view.
     */
    left: IDiffView;
    leftChunks(): IMergeViewDiffChunk[];
    leftOriginal(): CodeMirror.Editor;

    /**
     * Right side of the merge view.
     */
    right: IDiffView;
    rightChunks(): IMergeViewDiffChunk[];
    rightOriginal(): CodeMirror.Editor;

    /**
     * Sets whether or not the merge view should show the differences between the editor views.
     */
    setShowDifferences(showDifferences: boolean): void;
  }

  /**
   * Tracks changes in chunks from oroginal to new.
   */
  export interface IMergeViewDiffChunk {
    editFrom: number;
    editTo: number;
    origFrom: number;
    origTo: number;
  }

  export interface IDiffView {
    /**
     * Forces the view to reload.
     */
    forceUpdate(): (mode: string) => void;

    /**
     * Sets whether or not the merge view should show the differences between the editor views.
     */
    setShowDifferences(showDifferences: boolean): void;
  }

  export type Chunk = {
    origFrom: number;
    origTo: number;
    editFrom: number;
    editTo: number;
  };

  export type Diff = [number, string];
}

const Pos = CodeMirror.Pos;
const svgNS = 'http://www.w3.org/2000/svg';

class DiffView implements MergeView.IDiffView {
  constructor(mv: MergeView, type: 'left' | 'right') {
    this.mv = mv;
    this.type = type;
    this.classes =
      type == 'left'
        ? {
            chunk: 'CodeMirror-merge-l-chunk',
            start: 'CodeMirror-merge-l-chunk-start',
            end: 'CodeMirror-merge-l-chunk-end',
            insert: 'CodeMirror-merge-l-inserted',
            del: 'CodeMirror-merge-l-deleted',
            connect: 'CodeMirror-merge-l-connect'
          }
        : {
            chunk: 'CodeMirror-merge-r-chunk',
            start: 'CodeMirror-merge-r-chunk-start',
            end: 'CodeMirror-merge-r-chunk-end',
            insert: 'CodeMirror-merge-r-inserted',
            del: 'CodeMirror-merge-r-deleted',
            connect: 'CodeMirror-merge-r-connect'
          };
  }

  init(
    pane: HTMLElement,
    orig: string | CodeMirror.Doc,
    options: MergeView.IMergeViewEditorConfiguration
  ) {
    this.edit = this.mv.edit;
    (this.edit.state.diffViews || (this.edit.state.diffViews = [])).push(this);
    this.orig = CodeMirror(pane, {
      ...options,
      value: orig,
      readOnly: !this.mv.options.allowEditingOriginals
    });
    if (this.mv.options.connect == 'align') {
      if (!this.edit.state.trackAlignable) {
        this.edit.state.trackAlignable = new TrackAlignable(this.edit);
      }
      this.orig.state.trackAlignable = new TrackAlignable(this.orig);
    }
    // @ts-ignore
    this.lockButton.title = this.edit.phrase('Toggle locked scrolling');

    this.orig.state.diffViews = [this];
    // @ts-ignore
    let classLocation = options.chunkClassLocation || 'background';
    if (Object.prototype.toString.call(classLocation) != '[object Array]') {
      classLocation = [classLocation];
    }
    this.classes.classLocation = classLocation;

    this.diff = getDiff(
      asString(orig),
      asString(options.value),
      this.mv.options.ignoreWhitespace
    );
    this.chunks = getChunks(this.diff);
    this.diffOutOfDate = this.dealigned = false;
    this.needsScrollSync = null;

    this.showDifferences = options.showDifferences !== false;
  }

  registerEvents(otherDv: DiffView) {
    this.forceUpdate = DiffView.registerUpdate(this);
    DiffView.setScrollLock(this, true, false);
    DiffView.registerScroll(this, otherDv);
  }

  setShowDifferences(val: boolean): void {
    val = val !== false;
    if (val != this.showDifferences) {
      this.showDifferences = val;
      this.forceUpdate('full');
    }
  }

  static setScrollLock(dv: DiffView, val, action?) {
    dv.lockScroll = val;
    if (val && action != false) {
      if (DiffView.syncScroll(dv, true)) {
        makeConnections(dv);
      }
    }
    // @ts-ignore
    (val ? CodeMirror.addClass : CodeMirror.rmClass)(
      dv.lockButton,
      'CodeMirror-merge-scrolllock-enabled'
    );
  }

  private static registerUpdate(dv: DiffView): (mode?: string) => void {
    let edit = { from: 0, to: 0, marked: [] };
    let orig = { from: 0, to: 0, marked: [] };
    let debounceChange: number;
    let updatingFast: boolean = false;

    function update(mode?: string) {
      DiffView.updating = true;
      updatingFast = false;
      if (mode == 'full') {
        // @ts-ignore
        if (dv.svg) {
          clear(dv.svg);
        }
        // @ts-ignore
        if (dv.copyButtons) {
          clear(dv.copyButtons);
        }
        clearMarks(dv.edit, edit.marked, dv.classes);
        clearMarks(dv.orig, orig.marked, dv.classes);
        edit.from = edit.to = orig.from = orig.to = 0;
      }
      ensureDiff(dv);
      if (dv.showDifferences) {
        updateMarks(dv.edit, dv.diff, edit, DIFF_INSERT, dv.classes);
        updateMarks(dv.orig, dv.diff, orig, DIFF_DELETE, dv.classes);
      }

      if (dv.mv.options.connect == 'align') {
        alignChunks(dv);
      }
      makeConnections(dv);
      if (dv.needsScrollSync != null) {
        DiffView.syncScroll(dv, dv.needsScrollSync);
      }

      DiffView.updating = false;
    }
    function setDealign(fast: boolean): void {
      if (DiffView.updating) {
        return;
      }
      dv.dealigned = true;
      set(fast);
    }
    function set(fast: boolean): void {
      if (DiffView.updating || updatingFast) {
        return;
      }
      clearTimeout(debounceChange);
      if (fast === true) {
        updatingFast = true;
      }
      debounceChange = setTimeout(update, fast === true ? 20 : 250);
    }
    function change(
      _cm: CodeMirror.Editor,
      change: CodeMirror.EditorChangeLinkedList
    ): void {
      if (!dv.diffOutOfDate) {
        dv.diffOutOfDate = true;
        edit.from = edit.to = orig.from = orig.to = 0;
      }
      // Update faster when a line was added/removed
      setDealign(change.text.length - 1 != change.to.line - change.from.line);
    }
    function swapDoc(): void {
      dv.diffOutOfDate = true;
      dv.dealigned = true;
      update('full');
    }
    dv.edit.on('change', change);
    dv.orig.on('change', change);
    dv.edit.on('swapDoc', swapDoc);
    dv.orig.on('swapDoc', swapDoc);
    if (dv.mv.options.connect === 'align') {
      CodeMirror.on(dv.edit.state.trackAlignable, 'realign', setDealign);
      CodeMirror.on(dv.orig.state.trackAlignable, 'realign', setDealign);
    }
    dv.edit.on('viewportChange', function() {
      set(false);
    });
    dv.orig.on('viewportChange', function() {
      set(false);
    });
    update();
    return update;
  }

  private static registerScroll(dv: DiffView, otherDv: DiffView) {
    dv.edit.on('scroll', function() {
      if (DiffView.syncScroll(dv, true)) {
        makeConnections(dv);
      }
    });
    dv.orig.on('scroll', function() {
      if (DiffView.syncScroll(dv, false)) {
        makeConnections(dv);
      }
      if (otherDv) {
        if (DiffView.syncScroll(otherDv, true)) {
          makeConnections(otherDv);
        }
      }
    });
  }

  private static syncScroll(dv: DiffView, toOrig: boolean) {
    // Change handler will do a refresh after a timeout when diff is out of date
    if (dv.diffOutOfDate) {
      if (dv.lockScroll && dv.needsScrollSync == null) {
        dv.needsScrollSync = toOrig;
      }
      return false;
    }
    dv.needsScrollSync = null;
    if (!dv.lockScroll) {
      return true;
    }
    let editor: CodeMirror.Editor;
    let other: CodeMirror.Editor;
    let now = +new Date();
    if (toOrig) {
      editor = dv.edit;
      other = dv.orig;
    } else {
      editor = dv.orig;
      other = dv.edit;
    }
    // Don't take action if the position of this editor was recently set
    // (to prevent feedback loops)
    if (
      editor.state.scrollSetBy == dv &&
      (editor.state.scrollSetAt || 0) + 250 > now
    ) {
      return false;
    }

    let sInfo = editor.getScrollInfo();
    let targetPos: number = 0;
    if (dv.mv.options.connect == 'align') {
      targetPos = sInfo.top;
    } else {
      let halfScreen = 0.5 * sInfo.clientHeight;
      let midY = sInfo.top + halfScreen;
      let mid = editor.lineAtHeight(midY, 'local');
      let around = chunkBoundariesAround(dv.chunks, mid, toOrig);
      let off = DiffView.getOffsets(editor, toOrig ? around.edit : around.orig);
      let offOther = DiffView.getOffsets(
        other,
        toOrig ? around.orig : around.edit
      );
      let ratio = (midY - off.top) / (off.bot - off.top);
      targetPos =
        offOther.top - halfScreen + ratio * (offOther.bot - offOther.top);

      let botDist: number;
      let mix: number;
      // Some careful tweaking to make sure no space is left out of view
      // when scrolling to top or bottom.
      if (targetPos > sInfo.top) {
        mix = sInfo.top / halfScreen;
        if (mix < 1) {
          targetPos = targetPos * mix + sInfo.top * (1 - mix);
        }
      } else {
        botDist = sInfo.height - sInfo.clientHeight - sInfo.top;
        if (botDist < halfScreen) {
          let otherInfo = other.getScrollInfo();
          let botDistOther =
            otherInfo.height - otherInfo.clientHeight - targetPos;
          if (botDistOther > botDist) {
            mix = botDist / halfScreen;
            if (mix < 1) {
              targetPos =
                targetPos * mix +
                (otherInfo.height - otherInfo.clientHeight - botDist) *
                  (1 - mix);
            }
          }
        }
      }
    }

    other.scrollTo(sInfo.left, targetPos);
    other.state.scrollSetAt = now;
    other.state.scrollSetBy = dv;
    return true;
  }

  private static getOffsets(editor, around) {
    let bot = around.after;
    if (bot == null) {
      bot = editor.lastLine() + 1;
    }
    return {
      top: editor.heightAtLine(around.before || 0, 'local'),
      bot: editor.heightAtLine(bot, 'local')
    };
  }

  mv: MergeView;
  type: 'left' | 'right';
  classes;
  edit: CodeMirror.Editor;
  orig: CodeMirror.Editor;
  lockButton: HTMLElement;
  copyButtons: HTMLDivElement;
  svg: SVGSVGElement;
  gap: HTMLDivElement;
  lockScroll;
  diff;
  chunks: MergeView.Chunk[];
  dealigned: boolean;
  diffOutOfDate: boolean;
  needsScrollSync: boolean;
  showDifferences: boolean;
  forceUpdate: (mode?: string) => any;
  private static updating: boolean = false;
}

function ensureDiff(dv: DiffView) {
  if (dv.diffOutOfDate) {
    dv.diff = getDiff(
      dv.orig.getValue(),
      dv.edit.getValue(),
      dv.mv.options.ignoreWhitespace
    );
    dv.chunks = getChunks(dv.diff);
    dv.diffOutOfDate = false;
    CodeMirror.signal(dv.edit, 'updateDiff', dv.diff);
  }
}

// Updating the marks for editor content

function removeClass(editor: CodeMirror.Editor, line, classes) {
  let locs = classes.classLocation;
  for (let i = 0; i < locs.length; i++) {
    editor.removeLineClass(line, locs[i], classes.chunk);
    editor.removeLineClass(line, locs[i], classes.start);
    editor.removeLineClass(line, locs[i], classes.end);
  }
}

function isTextMarker(
  marker: CodeMirror.TextMarker
): marker is CodeMirror.TextMarker {
  return 'clear' in marker;
}

function clearMarks(editor: CodeMirror.Editor, arr, classes) {
  for (let i = 0; i < arr.length; ++i) {
    let mark = arr[i];
    if (isTextMarker(mark)) {
      mark.clear();
    } else if (mark.parent) {
      removeClass(editor, mark, classes);
    }
  }
  arr.length = 0;
}

// FIXME maybe add a margin around viewport to prevent too many updates
function updateMarks(editor: CodeMirror.Editor, diff, state, type, classes) {
  let vp = editor.getViewport();
  editor.operation(function() {
    if (
      state.from == state.to ||
      vp.from - state.to > 20 ||
      state.from - vp.to > 20
    ) {
      clearMarks(editor, state.marked, classes);
      markChanges(editor, diff, type, state.marked, vp.from, vp.to, classes);
      state.from = vp.from;
      state.to = vp.to;
    } else {
      if (vp.from < state.from) {
        markChanges(
          editor,
          diff,
          type,
          state.marked,
          vp.from,
          state.from,
          classes
        );
        state.from = vp.from;
      }
      if (vp.to > state.to) {
        markChanges(editor, diff, type, state.marked, state.to, vp.to, classes);
        state.to = vp.to;
      }
    }
  });
}

function addClass(
  editor: CodeMirror.Editor,
  lineNr,
  classes,
  main,
  start,
  end
) {
  let locs = classes.classLocation;
  // @ts-ignore
  let line = editor.getLineHandle(lineNr);
  for (let i = 0; i < locs.length; i++) {
    if (main) {
      editor.addLineClass(line, locs[i], classes.chunk);
    }
    if (start) {
      editor.addLineClass(line, locs[i], classes.start);
    }
    if (end) {
      editor.addLineClass(line, locs[i], classes.end);
    }
  }
  return line;
}

function markChanges(
  editor: CodeMirror.Editor,
  diff,
  type,
  marks,
  from,
  to,
  classes
) {
  let pos = Pos(0, 0);
  let top = Pos(from, 0);
  // @ts-ignore
  let bot = editor.clipPos(Pos(to - 1));
  let cls = type == DIFF_DELETE ? classes.del : classes.insert;
  function markChunk(start, end) {
    let bfrom = Math.max(from, start);
    let bto = Math.min(to, end);
    for (let i = bfrom; i < bto; ++i) {
      marks.push(addClass(editor, i, classes, true, i == start, i == end - 1));
    }
    // When the chunk is empty, make sure a horizontal line shows up
    if (start == end && bfrom == end && bto == end) {
      if (bfrom) {
        marks.push(addClass(editor, bfrom - 1, classes, false, false, true));
      } else {
        marks.push(addClass(editor, bfrom, classes, false, true, false));
      }
    }
  }

  let chunkStart = 0;
  let pending = false;
  for (let i = 0; i < diff.length; ++i) {
    let part = diff[i];
    let tp = part[0];
    let str = part[1];
    if (tp == DIFF_EQUAL) {
      let cleanFrom = pos.line + (startOfLineClean(diff, i) ? 0 : 1);
      moveOver(pos, str);
      let cleanTo = pos.line + (endOfLineClean(diff, i) ? 1 : 0);
      if (cleanTo > cleanFrom) {
        if (pending) {
          markChunk(chunkStart, cleanFrom);
          pending = false;
        }
        chunkStart = cleanTo;
      }
    } else {
      pending = true;
      if (tp == type) {
        let end = moveOver(pos, str, true);
        let a = posMax(top, pos);
        let b = posMin(bot, end);
        if (!posEq(a, b)) {
          // @ts-ignore
          marks.push(editor.markText(a, b, { className: cls }));
        }
        pos = end;
      }
    }
  }
  if (pending) {
    markChunk(chunkStart, pos.line + 1);
  }
}

// Updating the gap between editor and original

function makeConnections(dv: DiffView) {
  if (!dv.showDifferences) {
    return;
  }

  let w: number = 0;
  if (dv.svg) {
    clear(dv.svg);
    w = dv.gap.offsetWidth;
    attrs(dv.svg, 'width', w, 'height', dv.gap.offsetHeight);
  }
  if (dv.copyButtons) {
    clear(dv.copyButtons);
  }

  let vpEdit = dv.edit.getViewport();
  let vpOrig = dv.orig.getViewport();
  let outerTop = dv.mv.wrap.getBoundingClientRect().top;
  let sTopEdit =
    outerTop -
    dv.edit.getScrollerElement().getBoundingClientRect().top +
    dv.edit.getScrollInfo().top;
  let sTopOrig =
    outerTop -
    dv.orig.getScrollerElement().getBoundingClientRect().top +
    dv.orig.getScrollInfo().top;
  for (let i = 0; i < dv.chunks.length; i++) {
    let ch = dv.chunks[i];
    if (
      ch.editFrom <= vpEdit.to &&
      ch.editTo >= vpEdit.from &&
      ch.origFrom <= vpOrig.to &&
      ch.origTo >= vpOrig.from
    ) {
      drawConnectorsForChunk(dv, ch, sTopOrig, sTopEdit, w);
    }
  }
}

function getMatchingOrigLine(editLine, chunks) {
  let editStart = 0;
  let origStart = 0;
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (chunk.editTo > editLine && chunk.editFrom <= editLine) {
      return null;
    }
    if (chunk.editFrom > editLine) {
      break;
    }
    editStart = chunk.editTo;
    origStart = chunk.origTo;
  }
  return origStart + (editLine - editStart);
}

// Combines information about chunks and widgets/markers to return
// an array of lines, in a single editor, that probably need to be
// aligned with their counterparts in the editor next to it.
function alignableFor(cm, chunks, isOrig) {
  let tracker = cm.state.trackAlignable;
  let start = cm.firstLine();
  let trackI = 0;
  let result = [];
  for (let i = 0; ; i++) {
    let chunk = chunks[i];
    let chunkStart = !chunk ? 1e9 : isOrig ? chunk.origFrom : chunk.editFrom;
    for (; trackI < tracker.alignable.length; trackI += 2) {
      let n = tracker.alignable[trackI] + 1;
      if (n <= start) {
        continue;
      }
      if (n <= chunkStart) {
        result.push(n);
      } else {
        break;
      }
    }
    if (!chunk) {
      break;
    }
    result.push((start = isOrig ? chunk.origTo : chunk.editTo));
  }
  return result;
}

// Given information about alignable lines in two editors, fill in
// the result (an array of three-element arrays) to reflect the
// lines that need to be aligned with each other.
function mergeAlignable(result, origAlignable, chunks, setIndex) {
  let rI = 0;
  let origI = 0;
  let chunkI = 0;
  let diff = 0;
  outer: for (; ; rI++) {
    let nextR = result[rI];
    let nextO = origAlignable[origI];
    if (!nextR && nextO == null) {
      break;
    }

    let rLine = nextR ? nextR[0] : 1e9;
    let oLine = nextO == null ? 1e9 : nextO;
    while (chunkI < chunks.length) {
      let chunk = chunks[chunkI];
      if (chunk.origFrom <= oLine && chunk.origTo > oLine) {
        origI++;
        rI--;
        continue outer;
      }
      if (chunk.editTo > rLine) {
        if (chunk.editFrom <= rLine) {
          continue outer;
        }
        break;
      }
      diff += chunk.origTo - chunk.origFrom - (chunk.editTo - chunk.editFrom);
      chunkI++;
    }
    if (rLine == oLine - diff) {
      nextR[setIndex] = oLine;
      origI++;
    } else if (rLine < oLine - diff) {
      nextR[setIndex] = rLine + diff;
    } else {
      let record = [oLine - diff, null, null];
      record[setIndex] = oLine;
      result.splice(rI, 0, record);
      origI++;
    }
  }
}

function findAlignedLines(dv: DiffView, other: DiffView) {
  let alignable = alignableFor(dv.edit, dv.chunks, false);
  let result = [];
  if (other) {
    for (let i = 0, j = 0; i < other.chunks.length; i++) {
      let n = other.chunks[i].editTo;
      while (j < alignable.length && alignable[j] < n) {
        j++;
      }
      if (j == alignable.length || alignable[j] != n) {
        alignable.splice(j++, 0, n);
      }
    }
  }
  for (let i = 0; i < alignable.length; i++) {
    result.push([alignable[i], null, null]);
  }

  mergeAlignable(result, alignableFor(dv.orig, dv.chunks, true), dv.chunks, 1);
  if (other) {
    mergeAlignable(
      result,
      alignableFor(other.orig, other.chunks, true),
      other.chunks,
      2
    );
  }

  return result;
}

function alignChunks(dv: DiffView, force?: boolean) {
  if (!dv.dealigned && !force) {
    return;
  }
  // @ts-ignore
  if (!dv.orig.curOp) {
    return dv.orig.operation(function() {
      alignChunks(dv, force);
    });
  }

  dv.dealigned = false;
  const other = dv.mv.left == dv ? dv.mv.right : dv.mv.left;
  if (other) {
    ensureDiff(other);
    other.dealigned = false;
  }
  let linesToAlign = findAlignedLines(dv, other);

  // Clear old aligners
  let aligners = dv.mv.aligners;
  for (let i = 0; i < aligners.length; i++) {
    aligners[i].clear();
  }
  aligners.length = 0;

  let cm = [dv.edit, dv.orig];
  let scroll = [];
  if (other) {
    cm.push(other.orig);
  }
  for (let i = 0; i < cm.length; i++) {
    scroll.push(cm[i].getScrollInfo().top);
  }

  for (let ln = 0; ln < linesToAlign.length; ln++) {
    alignLines(cm, linesToAlign[ln], aligners);
  }

  for (let i = 0; i < cm.length; i++) {
    cm[i].scrollTo(null, scroll[i]);
  }
}

function alignLines(cm: CodeMirror.Editor[], lines, aligners) {
  let maxOffset = 0;
  let offset = [];
  for (let i = 0; i < cm.length; i++) {
    if (lines[i] != null) {
      let off = cm[i].heightAtLine(lines[i], 'local');
      offset[i] = off;
      maxOffset = Math.max(maxOffset, off);
    }
  }
  for (let i = 0; i < cm.length; i++) {
    if (lines[i] != null) {
      let diff = maxOffset - offset[i];
      if (diff > 1) {
        aligners.push(padAbove(cm[i], lines[i], diff));
      }
    }
  }
}

function padAbove(cm, line, size) {
  let above = true;
  if (line > cm.lastLine()) {
    line--;
    above = false;
  }
  let elt = document.createElement('div');
  elt.className = 'CodeMirror-merge-spacer';
  elt.style.height = size + 'px';
  elt.style.minWidth = '1px';
  return cm.addLineWidget(line, elt, {
    height: size,
    above: above,
    mergeSpacer: true,
    handleMouseEvents: true
  });
}

function drawConnectorsForChunk(dv, chunk, sTopOrig, sTopEdit, w) {
  let flip = dv.type == 'left';
  let top = dv.orig.heightAtLine(chunk.origFrom, 'local', true) - sTopOrig;
  if (dv.svg) {
    let topLpx = top;
    let topRpx = dv.edit.heightAtLine(chunk.editFrom, 'local', true) - sTopEdit;
    if (flip) {
      let tmp = topLpx;
      topLpx = topRpx;
      topRpx = tmp;
    }
    let botLpx = dv.orig.heightAtLine(chunk.origTo, 'local', true) - sTopOrig;
    let botRpx = dv.edit.heightAtLine(chunk.editTo, 'local', true) - sTopEdit;
    if (flip) {
      let tmp = botLpx;
      botLpx = botRpx;
      botRpx = tmp;
    }
    let curveTop =
      ' C ' +
      w / 2 +
      ' ' +
      topRpx +
      ' ' +
      w / 2 +
      ' ' +
      topLpx +
      ' ' +
      (w + 2) +
      ' ' +
      topLpx;
    let curveBot =
      ' C ' +
      w / 2 +
      ' ' +
      botLpx +
      ' ' +
      w / 2 +
      ' ' +
      botRpx +
      ' -1 ' +
      botRpx;
    attrs(
      dv.svg.appendChild(document.createElementNS(svgNS, 'path')),
      'd',
      'M -1 ' +
        topRpx +
        curveTop +
        ' L ' +
        (w + 2) +
        ' ' +
        botLpx +
        curveBot +
        ' z',
      'class',
      dv.classes.connect
    );
  }
  if (dv.copyButtons) {
    let copy = dv.copyButtons.appendChild(
      elt(
        'div',
        dv.type === 'left' ? '\u21dd' : '\u21dc',
        'CodeMirror-merge-copy'
      )
    );
    let editOriginals = dv.mv.options.allowEditingOriginals;
    copy.title = dv.edit.phrase(
      editOriginals ? 'Push to left' : 'Revert chunk'
    );
    copy.chunk = chunk;
    copy.style.top =
      (chunk.origTo > chunk.origFrom
        ? top
        : dv.edit.heightAtLine(chunk.editFrom, 'local') - sTopEdit) + 'px';

    if (editOriginals) {
      let topReverse = dv.edit.heightAtLine(chunk.editFrom, 'local') - sTopEdit;
      let copyReverse = dv.copyButtons.appendChild(
        elt(
          'div',
          dv.type == 'right' ? '\u21dd' : '\u21dc',
          'CodeMirror-merge-copy-reverse'
        )
      );
      copyReverse.title = 'Push to right';
      copyReverse.chunk = {
        editFrom: chunk.origFrom,
        editTo: chunk.origTo,
        origFrom: chunk.editFrom,
        origTo: chunk.editTo
      };
      copyReverse.style.top = topReverse + 'px';
      dv.type == 'right'
        ? (copyReverse.style.left = '2px')
        : (copyReverse.style.right = '2px');
    }
  }
}

function copyChunk(dv, to, from, chunk) {
  if (dv.diffOutOfDate) {
    return;
  }
  let origStart =
    chunk.origTo > from.lastLine()
      ? Pos(chunk.origFrom - 1)
      : Pos(chunk.origFrom, 0);
  let origEnd = Pos(chunk.origTo, 0);
  let editStart =
    chunk.editTo > to.lastLine()
      ? Pos(chunk.editFrom - 1)
      : Pos(chunk.editFrom, 0);
  let editEnd = Pos(chunk.editTo, 0);
  let handler = dv.mv.options.revertChunk;
  if (handler) {
    handler(dv.mv, from, origStart, origEnd, to, editStart, editEnd);
  } else {
    to.replaceRange(from.getRange(origStart, origEnd), editStart, editEnd);
  }
}

// Merge view, containing 0, 1, or 2 diff views.

/**
 * A function that calculates either a two-way or three-way merge between different sets of content.
 */
export function mergeView(
  node: HTMLElement,
  options?: MergeView.IMergeViewEditorConfiguration
): MergeView.IMergeViewEditor {
  return new MergeView(node, options);
}

class MergeView implements MergeView.IMergeViewEditor {
  constructor(
    node: HTMLElement,
    options?: MergeView.IMergeViewEditorConfiguration
  ) {
    this.options = options;
    let origLeft = options.origLeft == null ? options.orig : options.origLeft;
    let origRight = options.origRight;

    let hasLeft = origLeft != null;
    let hasRight = origRight != null;

    let panes = 1 + (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
    let wrap: HTMLDivElement[] = [];
    let left: DiffView | null = (this.left = null);
    let right: DiffView | null = (this.right = null);
    let self = this;

    let leftPane: HTMLDivElement = null;
    if (hasLeft) {
      left = this.left = new DiffView(this, 'left');
      leftPane = elt(
        'div',
        null,
        'CodeMirror-merge-pane CodeMirror-merge-left'
      );
      wrap.push(leftPane);
      wrap.push(buildGap(left));
    }

    let editPane = elt(
      'div',
      null,
      'CodeMirror-merge-pane CodeMirror-merge-editor'
    );
    wrap.push(editPane);

    let rightPane: HTMLDivElement = null;
    if (hasRight) {
      right = this.right = new DiffView(this, 'right');
      wrap.push(buildGap(right));
      rightPane = elt(
        'div',
        null,
        'CodeMirror-merge-pane CodeMirror-merge-right'
      );
      wrap.push(rightPane);
    }

    (hasRight ? rightPane : editPane).className +=
      ' CodeMirror-merge-pane-rightmost';

    wrap.push(elt('div', null, null, 'height: 0; clear: both;'));

    let wrapElt = (this.wrap = node.appendChild(
      elt('div', wrap, 'CodeMirror-merge CodeMirror-merge-' + panes + 'pane')
    ));
    this.edit = CodeMirror(editPane, { ...options });

    if (left) {
      left.init(leftPane, origLeft, options);
    }
    if (right) {
      right.init(rightPane, origRight, options);
    }
    if (options.collapseIdentical) {
      this.editor().operation(function() {
        collapseIdenticalStretches(self, options.collapseIdentical);
      });
    }
    if (options.connect == 'align') {
      this.aligners = [];
      alignChunks(this.left || this.right, true);
    }
    if (left) {
      left.registerEvents(right);
    }
    if (right) {
      right.registerEvents(left);
    }

    let onResize = function() {
      if (left) {
        makeConnections(left);
      }
      if (right) {
        makeConnections(right);
      }
    };
    CodeMirror.on(window, 'resize', onResize);
    let resizeInterval = setInterval(function() {
      let p = null;
      for (
        p = wrapElt.parentNode;
        p && p !== document.body;
        p = p.parentNode
      ) {}
      if (!p) {
        clearInterval(resizeInterval);
        CodeMirror.off(window, 'resize', onResize);
      }
    }, 5000);
  }

  editor(): CodeMirror.Editor {
    return this.edit;
  }

  rightOriginal(): CodeMirror.Editor {
    return this.right && this.right.orig;
  }

  leftOriginal(): CodeMirror.Editor {
    return this.left && this.left.orig;
  }

  setShowDifferences(val: boolean) {
    if (this.right) {
      this.right.setShowDifferences(val);
    }
    if (this.left) {
      this.left.setShowDifferences(val);
    }
  }

  rightChunks() {
    if (this.right) {
      ensureDiff(this.right);
      return this.right.chunks;
    }
  }

  leftChunks() {
    if (this.left) {
      ensureDiff(this.left);
      return this.left.chunks;
    }
  }

  options: MergeView.IMergeViewEditorConfiguration;
  left: DiffView | null;
  right: DiffView | null;
  wrap: HTMLDivElement;
  edit: CodeMirror.Editor;
  aligners: CodeMirror.LineWidget[];
}

function buildGap(dv: DiffView) {
  let lock = (dv.lockButton = elt('div', null, 'CodeMirror-merge-scrolllock'));
  let lockWrap = elt('div', [lock], 'CodeMirror-merge-scrolllock-wrap');
  CodeMirror.on(lock, 'click', function() {
    DiffView.setScrollLock(dv, !dv.lockScroll);
  });
  let gapElts: Element[] = [lockWrap];
  if (dv.mv.options.revertButtons !== false) {
    dv.copyButtons = elt(
      'div',
      null,
      'CodeMirror-merge-copybuttons-' + dv.type
    );
    CodeMirror.on(dv.copyButtons, 'click', function(e) {
      let node = e.target || e.srcElement;
      if (!node.chunk) {
        return;
      }
      if (node.className == 'CodeMirror-merge-copy-reverse') {
        copyChunk(dv, dv.orig, dv.edit, node.chunk);
        return;
      }
      copyChunk(dv, dv.edit, dv.orig, node.chunk);
    });
    gapElts.unshift(dv.copyButtons);
  }
  if (dv.mv.options.connect != 'align') {
    let svg =
      document.createElementNS && document.createElementNS(svgNS, 'svg');
    if (svg && !svg.createSVGRect) {
      svg = null;
    }
    dv.svg = svg;
    if (svg) {
      gapElts.push(svg);
    }
  }

  return (dv.gap = elt('div', gapElts, 'CodeMirror-merge-gap'));
}

function asString(obj) {
  if (typeof obj == 'string') {
    return obj;
  } else {
    return obj.getValue();
  }
}

// Operations on diffs
let dmp: diff_match_patch;
function getDiff(
  a: string,
  b: string,
  ignoreWhitespace?: boolean
): MergeView.Diff[] {
  if (!dmp) {
    dmp = new diff_match_patch();
  }

  let diff = dmp.diff_main(a, b);
  // The library sometimes leaves in empty parts, which confuse the algorithm
  for (let i = 0; i < diff.length; ++i) {
    let part = diff[i];
    if (ignoreWhitespace ? !/[^ \t]/.test(part[1]) : !part[1]) {
      diff.splice(i--, 1);
    } else if (i && diff[i - 1][0] == part[0]) {
      diff.splice(i--, 1);
      diff[i][1] += part[1];
    }
  }
  return diff;
}

function getChunks(diff: MergeView.Diff[]): MergeView.Chunk[] {
  let chunks: MergeView.Chunk[] = [];
  if (!diff.length) {
    return chunks;
  }
  let startEdit = 0;
  let startOrig = 0;
  let edit = Pos(0, 0);
  let orig = Pos(0, 0);
  for (let i = 0; i < diff.length; ++i) {
    let part = diff[i];
    let tp = part[0];
    if (tp == DIFF_EQUAL) {
      let startOff =
        !startOfLineClean(diff, i) ||
        edit.line < startEdit ||
        orig.line < startOrig
          ? 1
          : 0;
      let cleanFromEdit = edit.line + startOff;
      let cleanFromOrig = orig.line + startOff;
      moveOver(edit, part[1], null, orig);
      let endOff = endOfLineClean(diff, i) ? 1 : 0;
      let cleanToEdit = edit.line + endOff;
      let cleanToOrig = orig.line + endOff;
      if (cleanToEdit > cleanFromEdit) {
        if (i) {
          chunks.push({
            origFrom: startOrig,
            origTo: cleanFromOrig,
            editFrom: startEdit,
            editTo: cleanFromEdit
          });
        }
        startEdit = cleanToEdit;
        startOrig = cleanToOrig;
      }
    } else {
      moveOver(tp == DIFF_INSERT ? edit : orig, part[1]);
    }
  }
  if (startEdit <= edit.line || startOrig <= orig.line) {
    chunks.push({
      origFrom: startOrig,
      origTo: orig.line + 1,
      editFrom: startEdit,
      editTo: edit.line + 1
    });
  }
  return chunks;
}

function endOfLineClean(diff: MergeView.Diff[], i: number): boolean {
  if (i === diff.length - 1) {
    return true;
  }
  let next = diff[i + 1][1];
  if ((next.length === 1 && i < diff.length - 2) || next.charCodeAt(0) !== 10) {
    return false;
  }
  if (i === diff.length - 2) {
    return true;
  }
  next = diff[i + 2][1];
  return (next.length > 1 || i == diff.length - 3) && next.charCodeAt(0) === 10;
}

function startOfLineClean(diff: MergeView.Diff[], i: number): boolean {
  if (i === 0) {
    return true;
  }
  let last = diff[i - 1][1];
  if (last.charCodeAt(last.length - 1) != 10) {
    return false;
  }
  if (i == 1) {
    return true;
  }
  last = diff[i - 2][1];
  return last.charCodeAt(last.length - 1) == 10;
}

function chunkBoundariesAround(
  chunks: MergeView.Chunk[],
  n: number,
  nInEdit: boolean
) {
  let beforeE: number;
  let afterE: number;
  let beforeO: number;
  let afterO: number;
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    let fromLocal = nInEdit ? chunk.editFrom : chunk.origFrom;
    let toLocal = nInEdit ? chunk.editTo : chunk.origTo;
    if (afterE == null) {
      if (fromLocal > n) {
        afterE = chunk.editFrom;
        afterO = chunk.origFrom;
      } else if (toLocal > n) {
        afterE = chunk.editTo;
        afterO = chunk.origTo;
      }
    }
    if (toLocal <= n) {
      beforeE = chunk.editTo;
      beforeO = chunk.origTo;
    } else if (fromLocal <= n) {
      beforeE = chunk.editFrom;
      beforeO = chunk.origFrom;
    }
  }
  return {
    edit: { before: beforeE, after: afterE },
    orig: { before: beforeO, after: afterO }
  };
}

function collapseSingle(
  cm: CodeMirror.Editor,
  from: number,
  to: number
): { mark: CodeMirror.TextMarker; clear: () => void } {
  cm.addLineClass(from, 'wrap', 'CodeMirror-merge-collapsed-line');
  let widget = document.createElement('span');
  widget.className = 'CodeMirror-merge-collapsed-widget';
  // @ts-ignore
  widget.title = cm.phrase('Identical text collapsed. Click to expand.');
  // @ts-ignore
  let mark = cm.markText(Pos(from, 0), Pos(to - 1), {
    inclusiveLeft: true,
    inclusiveRight: true,
    replacedWith: widget,
    clearOnEnter: true
  });
  function clear() {
    mark.clear();
    cm.removeLineClass(from, 'wrap', 'CodeMirror-merge-collapsed-line');
  }
  if (mark.explicitlyCleared) {
    clear();
  }
  CodeMirror.on(widget, 'click', clear);
  mark.on('clear', clear);
  CodeMirror.on(widget, 'click', clear);
  return { mark: mark, clear: clear };
}

function collapseStretch(size: number, editors: any[]): any {
  let marks = [];
  function clear() {
    for (let i = 0; i < marks.length; i++) {
      marks[i].clear();
    }
  }
  for (let i = 0; i < editors.length; i++) {
    let editor = editors[i];
    let mark = collapseSingle(editor.cm, editor.line, editor.line + size);
    marks.push(mark);
    mark.mark.on('clear', clear);
  }
  return marks[0].mark;
}

function unclearNearChunks(
  dv: DiffView,
  margin: number,
  off: number,
  clear: boolean[]
) {
  for (let i = 0; i < dv.chunks.length; i++) {
    let chunk = dv.chunks[i];
    for (let l = chunk.editFrom - margin; l < chunk.editTo + margin; l++) {
      let pos = l + off;
      if (pos >= 0 && pos < clear.length) {
        clear[pos] = false;
      }
    }
  }
}

function collapseIdenticalStretches(mv: MergeView, margin: number | boolean) {
  if (typeof margin != 'number') {
    margin = 2;
  }
  let clear: boolean[] = [];
  let edit = mv.editor();
  // @ts-ignore
  let off: number = edit.firstLine();
  // @ts-ignore
  for (let l = off, e = edit.lastLine(); l <= e; l++) {
    clear.push(true);
  }
  if (mv.left) {
    unclearNearChunks(mv.left, margin, off, clear);
  }
  if (mv.right) {
    unclearNearChunks(mv.right, margin, off, clear);
  }

  for (let i = 0; i < clear.length; i++) {
    if (clear[i]) {
      let line = i + off;
      let size = 0;
      for (size = 1; i < clear.length - 1 && clear[i + 1]; i++, size++) {}
      if (size > margin) {
        let editors: { line: number; cm: CodeMirror.Editor }[] = [
          { line: line, cm: edit }
        ];
        if (mv.left) {
          editors.push({
            line: getMatchingOrigLine(line, mv.left.chunks),
            cm: mv.left.orig
          });
        }
        if (mv.right) {
          editors.push({
            line: getMatchingOrigLine(line, mv.right.chunks),
            cm: mv.right.orig
          });
        }
        let mark = collapseStretch(size, editors);
        if (mv.options.onCollapse) {
          mv.options.onCollapse(mv, line, size, mark);
        }
      }
    }
  }
}

// General utilities

function elt<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content: Node[] | string,
  className: string,
  style?: string
): HTMLElementTagNameMap[K] {
  let e = document.createElement<K>(tag);
  if (className) {
    e.className = className;
  }
  if (style) {
    e.style.cssText = style;
  }
  if (typeof content == 'string') {
    e.appendChild(document.createTextNode(content));
  } else if (content) {
    for (let i = 0; i < content.length; ++i) {
      e.appendChild(content[i]);
    }
  }
  return e;
}

function clear(node: ChildNode): void {
  for (let count = node.childNodes.length; count > 0; --count) {
    node.removeChild(node.firstChild);
  }
}

function attrs(elt: Element, ...args: any[]): void {
  for (let i = 1; i < arguments.length; i += 2) {
    elt.setAttribute(arguments[i], arguments[i + 1]);
  }
}

function moveOver(
  pos: CodeMirror.Position,
  str: string,
  copy?: boolean,
  other?: CodeMirror.Position
): CodeMirror.Position {
  let out = copy ? Pos(pos.line, pos.ch) : pos;
  let at = 0;
  for (;;) {
    let nl = str.indexOf('\n', at);
    if (nl == -1) {
      break;
    }
    ++out.line;
    if (other) {
      ++other.line;
    }
    at = nl + 1;
  }
  out.ch = (at ? 0 : out.ch) + (str.length - at);
  if (other) {
    other.ch = (at ? 0 : other.ch) + (str.length - at);
  }
  return out;
}

// Tracks collapsed markers and line widgets, in order to be able to
// accurately align the content of two editors.

const F_WIDGET = 1;
const F_WIDGET_BELOW = 2;
const F_MARKER = 4;

class TrackAlignable {
  cm: CodeMirror.Editor;
  alignable: Array<any>;
  height: number;

  constructor(cm: CodeMirror.Editor) {
    this.cm = cm;
    this.alignable = [];
    // @ts-ignore
    this.height = cm.doc.height;
    let self = this;
    // @ts-ignore
    cm.on('markerAdded', function(_, marker) {
      if (!marker.collapsed) {
        return;
      }
      let found = marker.find(1);
      if (found != null) {
        self.set(found.line, F_MARKER);
      }
    });
    // @ts-ignore
    cm.on('markerCleared', function(_, marker, _min, max) {
      if (max !== null && marker.collapsed) {
        self.check(max, F_MARKER, self.hasMarker);
      }
    });
    cm.on('markerChanged', this.signal.bind(this));
    // @ts-ignore
    cm.on('lineWidgetAdded', function(_, widget, lineNo) {
      if (widget.mergeSpacer) {
        return;
      }
      if (widget.above) {
        self.set(lineNo - 1, F_WIDGET_BELOW);
      } else {
        self.set(lineNo, F_WIDGET);
      }
    });
    // @ts-ignore
    cm.on('lineWidgetCleared', function(_, widget, lineNo) {
      if (widget.mergeSpacer) {
        return;
      }
      if (widget.above) {
        self.check(lineNo - 1, F_WIDGET_BELOW, self.hasWidgetBelow);
      } else {
        self.check(lineNo, F_WIDGET, self.hasWidget);
      }
    });
    cm.on('lineWidgetChanged', this.signal.bind(this));
    cm.on('change', function(_, change) {
      let start = change.from.line;
      let nBefore = change.to.line - change.from.line;
      let nAfter = change.text.length - 1;
      let end = start + nAfter;
      if (nBefore || nAfter) {
        self.map(start, nBefore, nAfter);
      }
      self.check(end, F_MARKER, self.hasMarker);
      if (nBefore || nAfter) {
        self.check(change.from.line, F_MARKER, self.hasMarker);
      }
    });
    cm.on('viewportChange', function() {
      // @ts-ignore
      if (self.cm.doc.height !== self.height) {
        self.signal();
      }
    });
  }

  signal() {
    CodeMirror.signal(this, 'realign');
    // @ts-ignore
    this.height = this.cm.doc.height;
  }

  /* tslint:disable:no-bitwise */
  set(n, flags) {
    let pos = -1;
    for (; pos < this.alignable.length; pos += 2) {
      let diff = this.alignable[pos] - n;
      if (diff == 0) {
        if ((this.alignable[pos + 1] & flags) == flags) {
          return;
        }
        this.alignable[pos + 1] |= flags;
        this.signal();
        return;
      }
      if (diff > 0) {
        break;
      }
    }
    this.signal();
    this.alignable.splice(pos, 0, n, flags);
  }
  /* tslint:enable:no-bitwise */

  find(n: number): number {
    for (let i = 0; i < this.alignable.length; i += 2) {
      if (this.alignable[i] == n) {
        return i;
      }
    }
    return -1;
  }

  /* tslint:disable:no-bitwise */
  check(n: number, flag, pred) {
    let found = this.find(n);
    if (found == -1 || !(this.alignable[found + 1] & flag)) {
      return;
    }
    if (!pred.call(this, n)) {
      this.signal();
      let flags = this.alignable[found + 1] & ~flag;
      if (flags) {
        this.alignable[found + 1] = flags;
      } else {
        this.alignable.splice(found, 2);
      }
    }
  }
  /* tslint:enable:no-bitwise */

  hasMarker(n: number): boolean {
    // @ts-ignore
    let handle = this.cm.getLineHandle(n);
    if (handle.markedSpans) {
      for (let i = 0; i < handle.markedSpans.length; i++) {
        if (
          handle.markedSpans[i].marker.collapsed &&
          handle.markedSpans[i].to !== null
        ) {
          return true;
        }
      }
    }
    return false;
  }

  hasWidget(n: number): boolean {
    // @ts-ignore
    let handle = this.cm.getLineHandle(n);
    if (handle.widgets) {
      for (let i = 0; i < handle.widgets.length; i++) {
        if (!handle.widgets[i].above && !handle.widgets[i].mergeSpacer) {
          return true;
        }
      }
    }
    return false;
  }

  hasWidgetBelow(n: number): boolean {
    // @ts-ignore
    if (n == this.cm.lastLine()) {
      return false;
    }
    // @ts-ignore
    let handle = this.cm.getLineHandle(n + 1);
    if (handle.widgets) {
      for (let i = 0; i < handle.widgets.length; i++) {
        if (handle.widgets[i].above && !handle.widgets[i].mergeSpacer) {
          return true;
        }
      }
    }
    return false;
  }

  /* tslint:disable:no-bitwise */
  map(from: number, nBefore: number, nAfter: number) {
    let diff = nAfter - nBefore;
    let to = from + nBefore;
    let widgetFrom = -1;
    let widgetTo = -1;
    for (let i = 0; i < this.alignable.length; i += 2) {
      let n = this.alignable[i];
      if (n == from && this.alignable[i + 1] & F_WIDGET_BELOW) {
        widgetFrom = i;
      }
      if (n == to && this.alignable[i + 1] & F_WIDGET_BELOW) {
        widgetTo = i;
      }
      if (n <= from) {
        continue;
      } else if (n < to) {
        this.alignable.splice(i--, 2);
      } else {
        this.alignable[i] += diff;
      }
    }
    if (widgetFrom > -1) {
      let flags = this.alignable[widgetFrom + 1];
      if (flags == F_WIDGET_BELOW) {
        this.alignable.splice(widgetFrom, 2);
      } else {
        this.alignable[widgetFrom + 1] = flags & ~F_WIDGET_BELOW;
      }
    }
    if (widgetTo > -1 && nAfter) {
      this.set(from + nAfter, F_WIDGET_BELOW);
    }
  }
}
/* tslint:enable:no-bitwise */

function posMin(a: CodeMirror.Position, b: CodeMirror.Position) {
  return (a.line - b.line || a.ch - b.ch) < 0 ? a : b;
}
function posMax(a: CodeMirror.Position, b: CodeMirror.Position) {
  return (a.line - b.line || a.ch - b.ch) > 0 ? a : b;
}
function posEq(a: CodeMirror.Position, b: CodeMirror.Position) {
  return a.line == b.line && a.ch == b.ch;
}

function findPrevDiff(chunks, start: number, isOrig: boolean) {
  for (let i = chunks.length - 1; i >= 0; i--) {
    let chunk = chunks[i];
    let to = (isOrig ? chunk.origTo : chunk.editTo) - 1;
    if (to < start) {
      return to;
    }
  }
}

function findNextDiff(chunks, start: number, isOrig: boolean) {
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    let from = isOrig ? chunk.origFrom : chunk.editFrom;
    if (from > start) {
      return from;
    }
  }
}

function goNearbyDiff(cm: CodeMirror.Editor, dir: number) {
  let found = null;
  let views = cm.state.diffViews;
  // @ts-ignore
  let line = cm.getCursor().line;
  if (views) {
    for (let i = 0; i < views.length; i++) {
      let dv = views[i];
      let isOrig = cm == dv.orig;
      ensureDiff(dv);
      let pos =
        dir < 0
          ? findPrevDiff(dv.chunks, line, isOrig)
          : findNextDiff(dv.chunks, line, isOrig);
      if (
        pos != null &&
        (found == null || (dir < 0 ? pos > found : pos < found))
      ) {
        found = pos;
      }
    }
  }
  if (found != null) {
    // @ts-ignore
    cm.setCursor(found, 0);
  } else {
    return CodeMirror.Pass;
  }
}

// @ts-ignore
CodeMirror.commands.goNextDiff = function(cm: CodeMirror.Editor) {
  return goNearbyDiff(cm, 1);
};

// @ts-ignore
CodeMirror.commands.goPrevDiff = function(cm: CodeMirror.Editor) {
  return goNearbyDiff(cm, -1);
};
