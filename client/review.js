(() => {
  const reviewRoot = document.getElementById('review-root');
  const finishButton = document.querySelector('[data-finish]');
  const globalStatus = document.querySelector('[data-global-status]');
  if (!reviewRoot || !finishButton || !globalStatus) return;

  const POST_PATH = '/__pi_code_review_post__';
  const RESOLVE_PATH = '/__pi_code_review_resolve__';
  const EVENTS_PATH = '/__pi_code_review_events__';
  const FINISH_PATH = '/__pi_code_review_finish__';
  const RESUME_PATH = '/__pi_code_review_resume__';
  const VIEWED_PATH = '/__pi_code_review_viewed__';
  const AMEND_PATH = '/__pi_code_review_amend__';
  const SEND_PATH = '/__pi_code_review_send__';

  const myRound = Number(document.body.dataset.round || 1);
  let currentRound = Number(document.body.dataset.currentRound || myRound);
  let phase = document.body.dataset.phase || 'reviewing';
  const loadedAsCurrent = myRound === currentRound;
  let autoNavigating = false;
  const isSuperseded = () => myRound < currentRound;
  const isLocked = () => isSuperseded() || phase !== 'reviewing';

  const threads = new Map();
  const highlights = new Map();
  let nextHighlightId = 1;
  let draft;
  let navIndex = -1;
  let currentThreadId;
  const overviewSection = reviewRoot.querySelector('[data-review-overview]');
  let showingOverview = Boolean(overviewSection);
  const fileSections = [...reviewRoot.querySelectorAll('[data-review-file]')];
  let activeIndex = Number(fileSections.find((section) => !section.hidden)?.dataset.reviewFile ?? 0);
  const navButtons = [...document.querySelectorAll('[data-file-nav]')];
  const inbox = document.querySelector('[data-inbox]');
  const tally = document.querySelector('[data-thread-tally]');
  const shortcutsOverlay = document.querySelector('[data-shortcuts-overlay]');
  const phaseBanner = document.querySelector('[data-phase-banner]');
  const phaseBannerText = document.querySelector('[data-phase-banner-text]');
  const resumeButton = document.querySelector('[data-resume]');
  const gotoCurrent = document.querySelector('[data-goto-current]');
  const roundSwitcher = document.querySelector('[data-round-switcher]');
  const staleBadge = document.querySelector('[data-stale-badge]');
  let stale = false;

  const applySessionState = () => {
    document.body.classList.toggle('locked', isLocked());
    // Drift is expected while Pi revises and irrelevant on superseded rounds.
    if (staleBadge) staleBadge.hidden = !stale || phase !== 'reviewing' || isSuperseded();
    document.querySelectorAll('[data-viewed-toggle]').forEach((box) => { box.disabled = isSuperseded(); });
    if (phaseBanner && phaseBannerText && resumeButton && gotoCurrent) {
      if (isSuperseded()) {
        phaseBanner.hidden = false;
        phaseBannerText.textContent = 'Round ' + myRound + ' is read-only — round ' + currentRound + ' is current.';
        resumeButton.hidden = true;
        gotoCurrent.hidden = false;
        gotoCurrent.href = '/round/' + currentRound;
      } else if (phase === 'revising') {
        phaseBanner.hidden = false;
        phaseBannerText.textContent = 'Pi is revising — round ' + (myRound + 1) + ' pending. Reading stays open; to keep commenting on this round, resume it.';
        resumeButton.hidden = false;
        gotoCurrent.hidden = true;
      } else {
        phaseBanner.hidden = true;
      }
    }
    if (roundSwitcher) {
      roundSwitcher.hidden = currentRound <= 1;
      roundSwitcher.replaceChildren(...Array.from({ length: currentRound }, (_, index) => {
        const number = index + 1;
        const link = document.createElement('a');
        link.href = '/round/' + number;
        link.textContent = 'R' + number;
        if (number === currentRound) link.classList.add('current');
        if (number === myRound) link.classList.add('viewing');
        link.title = number === currentRound ? 'Round ' + number + ' (current)' : 'Round ' + number + ' (read-only)';
        return link;
      }));
    }
  };

  const setStatus = (message, error = false) => {
    globalStatus.textContent = message;
    globalStatus.style.color = error ? '#cf222e' : '';
  };
  const errorMessage = (error) => (error instanceof Error ? error.message : 'Request failed');
  const postJson = async (path, payload) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.text()) || 'Request failed');
    return response.json();
  };
  const postedStatus = (result, message) => {
    if (result.deliveryFailed) setStatus('Posted, but delivery to Pi failed; it stays in this thread and the pass summary.', true);
    else if (result.queued) setStatus('Queued — delivered when you send the round.');
    else if (result.pending) setStatus('Pending — delivered with the round, a live reply, or Send now.');
    else if (result.escalated) setStatus('Thread sent to Pi, including its pending messages.');
    else setStatus(message);
  };
  // Shift on the posting keystroke marks the post quiet; consumed per click so
  // plain button clicks always post live.
  let quietIntent = false;
  const consumeQuietIntent = () => {
    const quiet = quietIntent;
    quietIntent = false;
    return quiet;
  };

  const isAwaiting = (thread) => thread.status === 'open' && thread.turns.length > 0 && thread.turns[thread.turns.length - 1].author === 'pi';
  const sectionForPath = (path) => fileSections.find((section) => section.dataset.path === path);
  const sectionIndexOf = (thread) => {
    if (thread.source === 'overview' || !thread.file) return -1;
    const section = sectionForPath(thread.file);
    return section ? Number(section.dataset.reviewFile) : fileSections.length;
  };
  const threadNumber = (thread) => Number(thread.id.split('-t')[1]) || 0;
  const orderedAwaiting = () => [...threads.values()].filter(isAwaiting).sort((left, right) => sectionIndexOf(left) - sectionIndexOf(right) || threadNumber(left) - threadNumber(right));
  const commentaryThreadFor = (file, commentaryId) => [...threads.values()].find((thread) => thread.source === 'commentary' && thread.file === file && thread.commentaryId === commentaryId);

  // Navigation ---------------------------------------------------------------
  const showOverview = () => {
    if (!overviewSection) return;
    showingOverview = true;
    overviewSection.hidden = false;
    fileSections.forEach((section) => { section.hidden = true; section.classList.remove('active'); });
    document.querySelector('[data-overview-nav]')?.classList.add('active');
    navButtons.forEach((item) => item.classList.remove('active'));
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const showFile = (index) => {
    showingOverview = false;
    if (overviewSection) overviewSection.hidden = true;
    document.querySelector('[data-overview-nav]')?.classList.remove('active');
    activeIndex = index;
    fileSections.forEach((section) => {
      const sectionIndex = Number(section.dataset.reviewFile);
      section.hidden = sectionIndex !== index;
      section.classList.toggle('active', sectionIndex === index);
    });
    navButtons.forEach((item) => item.classList.toggle('active', Number(item.dataset.fileNav) === index));
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const confirmDiscardDraft = () => {
    if (!draft) return true;
    if (!window.confirm('Discard the unfinished diff comment?')) return false;
    cancelDraft();
    return true;
  };

  // Selection drafts ---------------------------------------------------------
  const activeFile = () => (showingOverview ? undefined : reviewRoot.querySelector('[data-review-file="' + activeIndex + '"]'));
  const renderHighlights = () => {
    if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== 'function') return false;
    if (highlights.size) CSS.highlights.set('pi-code-review-feedback', new Highlight(...highlights.values()));
    else CSS.highlights.delete('pi-code-review-feedback');
    return true;
  };
  const rangeSegments = (range) => {
    const segments = [];
    const walker = document.createTreeWalker(reviewRoot, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      let start = node === range.startContainer ? range.startOffset : 0;
      let end = node === range.endContainer ? range.endOffset : node.data.length;
      start = Math.max(0, Math.min(node.data.length, start));
      end = Math.max(start, Math.min(node.data.length, end));
      if (start < end) segments.push({ node, start, end });
    }
    return segments;
  };
  const overlaps = (left, right) => {
    const rightSegments = new Map(rangeSegments(right).map((part) => [part.node, part]));
    return rangeSegments(left).some((part) => {
      const other = rightSegments.get(part.node);
      return other && Math.max(part.start, other.start) < Math.min(part.end, other.end);
    });
  };
  const cancelDraft = () => {
    if (!draft) return;
    highlights.delete(draft.highlightId);
    renderHighlights();
    const composer = sectionForPath(draft.file)?.querySelector('[data-selection-composer]');
    if (composer) composer.hidden = true;
    draft = undefined;
    window.getSelection()?.removeAllRanges();
  };
  const closestCode = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.diff-code');
  const selectedRows = (range) => {
    const startCode = closestCode(range.startContainer);
    const endCode = closestCode(range.endContainer);
    const startRow = startCode?.closest('.diff-line');
    const endRow = endCode?.closest('.diff-line');
    if (!startRow || !endRow || startRow.dataset.fileIndex !== endRow.dataset.fileIndex) return undefined;
    if (startCode.classList.contains('unselectable') || endCode.classList.contains('unselectable')) return undefined;
    const section = startRow.closest('[data-review-file]');
    if (!section || section !== endRow.closest('[data-review-file]')) return undefined;
    const all = [...section.querySelectorAll('.diff-line')];
    const start = all.indexOf(startRow);
    const end = all.indexOf(endRow);
    const rows = all.slice(Math.min(start, end), Math.max(start, end) + 1);
    if (rows.some((row) => !['add', 'del', 'context'].includes(row.dataset.kind))) return undefined;
    return { section, rows };
  };
  const beginComment = () => {
    if (isLocked()) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const selected = selectedRows(range);
    if (!selected) {
      setStatus('Select diff code within a single file.', true);
      return;
    }
    const highlight = selection.toString().trim();
    if (!highlight) return;
    const pendingRange = range.cloneRange();
    if (draft) {
      if (!window.confirm('Discard the unfinished diff comment?')) {
        selection.removeAllRanges();
        return;
      }
      cancelDraft();
    }
    if ([...highlights.values()].some((existing) => overlaps(pendingRange, existing))) {
      setStatus('Choose code that is not already highlighted.', true);
      return;
    }
    const highlightId = nextHighlightId++;
    highlights.set(highlightId, pendingRange);
    if (!renderHighlights()) {
      highlights.delete(highlightId);
      setStatus('Text highlighting is not supported by this browser.', true);
      return;
    }
    const oldLines = selected.rows.map((row) => Number(row.dataset.oldLine)).filter(Number.isInteger);
    const newLines = selected.rows.map((row) => Number(row.dataset.newLine)).filter(Number.isInteger);
    const kinds = new Set(selected.rows.map((row) => row.dataset.kind));
    const side = kinds.size === 1 && kinds.has('add') ? 'new' : kinds.size === 1 && kinds.has('del') ? 'old' : 'both';
    draft = {
      highlightId,
      file: selected.section.dataset.path,
      side,
      oldStart: oldLines.length ? Math.min(...oldLines) : undefined,
      oldEnd: oldLines.length ? Math.max(...oldLines) : undefined,
      newStart: newLines.length ? Math.min(...newLines) : undefined,
      newEnd: newLines.length ? Math.max(...newLines) : undefined,
      highlight,
    };
    const composer = selected.section.querySelector('[data-selection-composer]');
    composer.hidden = false;
    composer.querySelector('[data-selection-quote]').textContent = highlight;
    const textarea = composer.querySelector('[data-selection-feedback]');
    textarea.value = '';
    composer.querySelector('[data-selection-add]').disabled = true;
    selection.removeAllRanges();
    textarea.focus();
    setStatus('Add feedback for the highlighted diff.');
  };
  reviewRoot.addEventListener('mouseup', () => window.setTimeout(beginComment, 0));
  reviewRoot.addEventListener('keyup', (event) => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) window.setTimeout(beginComment, 0);
  });
  document.querySelectorAll('[data-selection-composer]').forEach((composer) => {
    const textarea = composer.querySelector('[data-selection-feedback]');
    const add = composer.querySelector('[data-selection-add]');
    textarea.addEventListener('input', () => { add.disabled = !textarea.value.trim(); });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!add.disabled) {
        quietIntent = event.shiftKey;
        add.click();
      }
    });
    composer.querySelector('[data-selection-cancel]').addEventListener('click', cancelDraft);
    add.addEventListener('click', async () => {
      const quiet = consumeQuietIntent();
      if (!draft || !textarea.value.trim() || add.dataset.busy) return;
      add.dataset.busy = '1';
      add.disabled = true;
      try {
        const result = await postJson(POST_PATH, {
          round: myRound,
          ...(quiet ? { quiet: true } : {}),
          source: 'selection',
          file: draft.file,
          side: draft.side,
          ...(draft.oldStart === undefined ? {} : { oldStart: draft.oldStart, oldEnd: draft.oldEnd }),
          ...(draft.newStart === undefined ? {} : { newStart: draft.newStart, newEnd: draft.newEnd }),
          highlight: draft.highlight,
          body: textarea.value.trim(),
        });
        threadHighlights.set(result.thread.id, draft.highlightId);
        draft = undefined;
        composer.hidden = true;
        textarea.value = '';
        upsertThread(result.thread);
        postedStatus(result, 'Comment sent to Pi.');
        currentThreadId = result.thread.id;
      } catch (error) {
        add.disabled = false;
        setStatus(errorMessage(error), true);
      } finally {
        delete add.dataset.busy;
      }
    });
  });

  // Threads ------------------------------------------------------------------
  const threadHighlights = new Map();
  const removeThread = (threadId) => {
    threads.delete(threadId);
    document.querySelector('[data-thread-card="' + threadId + '"]')?.remove();
    const highlightId = threadHighlights.get(threadId);
    if (highlightId !== undefined) {
      highlights.delete(highlightId);
      threadHighlights.delete(threadId);
      renderHighlights();
    }
    if (currentThreadId === threadId) currentThreadId = undefined;
    updateAggregates();
  };
  // Queued (undelivered) reviewer messages stay editable until Pi sees them.
  const openTurnEditor = (entry, thread, turn, value, focus) => {
    entry.replaceChildren();
    const author = document.createElement('span');
    author.className = 'turn-author';
    author.textContent = 'You';
    const textarea = document.createElement('textarea');
    textarea.maxLength = 20000;
    textarea.dataset.turnEditor = String(turn.seq);
    textarea.value = value;
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.disabled = !value.trim();
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    textarea.addEventListener('input', () => { save.disabled = !textarea.value.trim(); });
    // Drop the marker before re-rendering, or renderThread's editor
    // preservation would immediately reopen the editor being closed.
    const closeEditor = () => {
      delete textarea.dataset.turnEditor;
      renderThread(threads.get(thread.id));
    };
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
        return;
      }
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!save.disabled) save.click();
    });
    cancel.addEventListener('click', closeEditor);
    save.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body) return;
      save.disabled = true;
      try {
        const result = await postJson(AMEND_PATH, { threadId: thread.id, seq: turn.seq, body });
        // Close this turn's editor before re-rendering; renderThread would
        // otherwise restore it (the guard that keeps in-progress edits alive
        // across SSE re-renders — which may already have replaced this textarea
        // element). Scoped by seq so sibling editors keep their drafts.
        const liveEditor = document.querySelector('[data-thread-card="' + thread.id + '"] [data-turn-editor="' + turn.seq + '"]');
        if (liveEditor) delete liveEditor.dataset.turnEditor;
        upsertThread(result.thread);
        setStatus('Queued message updated — Pi will see the new text.');
      } catch (error) {
        save.disabled = false;
        setStatus(errorMessage(error), true);
      }
    });
    const row = document.createElement('div');
    row.className = 'composer-actions';
    row.append(cancel, save);
    entry.append(author, textarea, row);
    if (focus) textarea.focus();
  };
  const threadHost = (thread) => {
    if (thread.carried) return [...document.querySelectorAll('[data-carried-host]')].find((host) => host.dataset.carriedHost === thread.id);
    if (thread.source === 'overview') return document.querySelector('[data-overview-thread]') || reviewRoot.querySelector('[data-selection-threads]');
    const section = sectionForPath(thread.file);
    if (thread.source === 'commentary') {
      const noteHost = section && [...section.querySelectorAll('[data-commentary-thread]')].find((host) => host.dataset.commentaryThread === thread.commentaryId);
      // Held threads (and any orphan) fall back so no conversation is ever invisible.
      return noteHost || section?.querySelector('[data-selection-threads]') || document.querySelector('[data-overview-thread]') || reviewRoot.querySelector('[data-selection-threads]');
    }
    return section?.querySelector('[data-selection-threads]') || document.querySelector('[data-overview-thread]') || reviewRoot.querySelector('[data-selection-threads]');
  };
  const resolveThread = async (threadId, resolved) => {
    if (isLocked()) {
      setStatus('This round is read-only.', true);
      return;
    }
    try {
      const result = await postJson(RESOLVE_PATH, { threadId, resolved });
      upsertThread(result.thread);
      setStatus(resolved ? 'Thread resolved.' : 'Thread reopened.');
    } catch (error) {
      setStatus(errorMessage(error), true);
    }
  };

  const renderThread = (thread) => {
    const host = threadHost(thread);
    if (!host) return;
    let card = host.querySelector('[data-thread-card="' + thread.id + '"]');
    if (thread.source === 'commentary' && !thread.carried && !thread.heldFrom && thread.turns.length === 1 && thread.status === 'open') {
      // A note the reviewer has not engaged with yet: the commentary card itself
      // is the thread's visual, so show its composer instead of an empty card.
      if (card) card.remove();
      const origin = [...(sectionForPath(thread.file)?.querySelectorAll('[data-commentary-composer]') ?? [])].find((element) => element.dataset.commentaryComposer === thread.commentaryId);
      if (origin) origin.hidden = false;
      return;
    }
    const previousReply = card?.querySelector('[data-thread-reply]');
    const previousDraft = previousReply?.value ?? '';
    const hadFocus = Boolean(previousReply) && document.activeElement === previousReply;
    const previousSelection = hadFocus ? [previousReply.selectionStart, previousReply.selectionEnd] : undefined;
    const editorStates = new Map();
    card?.querySelectorAll('[data-turn-editor]').forEach((editor) => {
      editorStates.set(Number(editor.dataset.turnEditor), { value: editor.value, focus: document.activeElement === editor });
    });
    if (!card) {
      card = document.createElement('article');
      card.className = 'thread-card';
      card.dataset.threadCard = thread.id;
      host.append(card);
    }
    const awaiting = isAwaiting(thread);
    card.classList.toggle('awaiting', awaiting);
    card.classList.toggle('resolved', thread.status === 'resolved');
    card.replaceChildren();
    const header = document.createElement('div');
    header.className = 'thread-card-header';
    const status = document.createElement('span');
    status.className = 'thread-status';
    const pendingCount = thread.status === 'open' ? thread.pending ?? 0 : 0;
    status.textContent = thread.status === 'resolved' ? 'Resolved'
      : thread.queued ? 'Queued for round'
      : pendingCount > 0 ? pendingCount + ' pending for round'
      : awaiting ? 'Pi replied' : 'Waiting for Pi';
    card.classList.toggle('queued', thread.status === 'open' && thread.queued === true);
    card.classList.toggle('pending', pendingCount > 0 && thread.queued !== true);
    const actions = document.createElement('div');
    actions.className = 'composer-actions';
    const resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.dataset.threadResolve = thread.id;
    resolve.textContent = thread.status === 'resolved' ? 'Reopen' : 'Resolve';
    resolve.addEventListener('click', () => resolveThread(thread.id, thread.status !== 'resolved'));
    actions.append(resolve);
    header.append(status, actions);
    card.append(header);
    if (thread.highlight) {
      const quote = document.createElement('div');
      quote.className = 'user-comment-quote';
      quote.textContent = thread.highlight;
      card.append(quote);
    }
    // Held commentary threads keep Pi's note turn visible: the originating
    // commentary card does not exist in this round.
    const turns = thread.source === 'commentary' && !thread.carried && !thread.heldFrom ? thread.turns.slice(1) : thread.turns;
    for (const turn of turns) {
      const entry = document.createElement('div');
      entry.className = 'thread-turn turn-' + turn.author;
      const author = document.createElement('span');
      author.className = 'turn-author';
      author.textContent = turn.author === 'pi' ? 'Pi' : 'You';
      author.title = new Date(turn.ts).toLocaleString();
      const body = document.createElement('div');
      body.textContent = turn.body;
      entry.append(author, body);
      const amendable = thread.status === 'open' && turn.author === 'user' && turn.delivered === false && !isLocked();
      const editing = amendable ? editorStates.get(turn.seq) : undefined;
      if (editing) {
        openTurnEditor(entry, thread, turn, editing.value, editing.focus);
      } else if (amendable) {
        const tools = document.createElement('div');
        tools.className = 'turn-tools';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.dataset.turnEdit = String(turn.seq);
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => openTurnEditor(entry, thread, turn, turn.body, true));
        const del = document.createElement('button');
        del.type = 'button';
        del.dataset.turnDelete = String(turn.seq);
        del.textContent = 'Delete';
        del.addEventListener('click', async () => {
          try {
            const result = await postJson(AMEND_PATH, { threadId: thread.id, seq: turn.seq, delete: true });
            if (result.removed) {
              removeThread(thread.id);
              setStatus('Queued comment deleted — Pi never saw it.');
            } else {
              upsertThread(result.thread);
              setStatus('Queued message deleted.');
            }
          } catch (error) {
            setStatus(errorMessage(error), true);
          }
        });
        const sendNow = document.createElement('button');
        sendNow.type = 'button';
        sendNow.dataset.turnSend = String(turn.seq);
        sendNow.textContent = 'Send now';
        sendNow.title = thread.pending > 1 ? 'Delivers all ' + thread.pending + ' of this thread\u2019s pending messages, in order' : 'Deliver this message to Pi now';
        sendNow.addEventListener('click', async () => {
          try {
            const result = await postJson(SEND_PATH, { threadId: thread.id });
            upsertThread(result.thread);
            postedStatus(result, result.sent > 1 ? result.sent + ' pending messages sent to Pi.' : 'Message sent to Pi.');
          } catch (error) {
            setStatus(errorMessage(error), true);
          }
        });
        tools.append(edit, del, sendNow);
        entry.append(tools);
      }
      card.append(entry);
    }
    if (thread.piProposedResolve && thread.status === 'open') {
      const proposal = document.createElement('div');
      proposal.className = 'pi-proposes';
      proposal.textContent = 'Pi proposes to resolve this thread. ';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.dataset.threadAcceptResolve = thread.id;
      accept.textContent = 'Accept & resolve';
      accept.addEventListener('click', () => resolveThread(thread.id, true));
      proposal.append(accept);
      card.append(proposal);
    }
    if (thread.status === 'open') {
      const composer = document.createElement('div');
      const textarea = document.createElement('textarea');
      textarea.maxLength = 20000;
      textarea.placeholder = 'Reply to Pi';
      textarea.dataset.threadReply = thread.id;
      textarea.value = previousDraft;
      const send = document.createElement('button');
      send.type = 'button';
      send.dataset.threadSend = thread.id;
      send.textContent = 'Reply';
      send.disabled = !previousDraft.trim();
      textarea.addEventListener('input', () => { send.disabled = !textarea.value.trim(); });
      textarea.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
        event.preventDefault();
        if (!send.disabled) {
          quietIntent = event.shiftKey;
          send.click();
        }
      });
      send.addEventListener('click', async () => {
        const quiet = consumeQuietIntent();
        const body = textarea.value.trim();
        if (!body) return;
        send.disabled = true;
        textarea.value = '';
        try {
          const result = await postJson(POST_PATH, { threadId: thread.id, body, ...(quiet ? { quiet: true } : {}) });
          upsertThread(result.thread);
          postedStatus(result, 'Reply sent to Pi.');
        } catch (error) {
          const restored = card.querySelector('[data-thread-reply]');
          if (restored && !restored.value.trim()) restored.value = body;
          const restoredSend = card.querySelector('[data-thread-send]');
          if (restoredSend) restoredSend.disabled = false;
          setStatus(errorMessage(error), true);
        }
      });
      const sendRow = document.createElement('div');
      sendRow.className = 'composer-actions';
      sendRow.append(send);
      composer.append(textarea, sendRow);
      card.append(composer);
      if (hadFocus) {
        textarea.focus();
        try { textarea.setSelectionRange(previousSelection[0], previousSelection[1]); } catch {}
      }
    }
    if (thread.source === 'commentary' && !thread.carried && !thread.heldFrom) {
      const section = sectionForPath(thread.file);
      const origin = [...(section?.querySelectorAll('[data-commentary-composer]') ?? [])].find((element) => element.dataset.commentaryComposer === thread.commentaryId);
      if (origin) origin.hidden = true;
    }
  };
  const updateAggregates = () => {
    const all = [...threads.values()];
    const awaiting = orderedAwaiting();
    if (inbox) {
      inbox.hidden = awaiting.length === 0;
      inbox.textContent = awaiting.length + ' awaiting you · n';
    }
    const perFile = new Map();
    let overviewCount = 0;
    for (const thread of awaiting) {
      if (thread.source === 'overview' || !thread.file) overviewCount++;
      else perFile.set(thread.file, (perFile.get(thread.file) ?? 0) + 1);
    }
    navButtons.forEach((button) => {
      const section = fileSections.find((candidate) => Number(candidate.dataset.reviewFile) === Number(button.dataset.fileNav));
      const count = section ? perFile.get(section.dataset.path) ?? 0 : 0;
      const badge = button.querySelector('[data-unread-badge]');
      if (!badge) return;
      badge.hidden = count === 0;
      badge.textContent = String(count);
    });
    const overviewBadge = document.querySelector('[data-overview-nav] [data-unread-badge]');
    if (overviewBadge) {
      overviewBadge.hidden = overviewCount === 0;
      overviewBadge.textContent = String(overviewCount);
    }
    const referenceBadge = document.querySelector('[data-reference-unread]');
    if (referenceBadge) {
      let referenceCount = 0;
      for (const [path, count] of perFile) {
        if (sectionForPath(path)?.dataset.reviewMode === 'reference') referenceCount += count;
      }
      referenceBadge.hidden = referenceCount === 0;
      referenceBadge.textContent = String(referenceCount);
    }
    const queuedCount = all.filter((thread) => thread.status === 'open' && thread.queued === true).length;
    const undeliveredCount = all.filter((thread) => thread.status === 'open').reduce((count, thread) => count + (thread.pending ?? 0), 0);
    const pendingOnLive = all.filter((thread) => thread.status === 'open' && thread.queued !== true).reduce((count, thread) => count + (thread.pending ?? 0), 0);
    if (finishButton && !finishButton.dataset.busy) {
      finishButton.textContent = undeliveredCount ? 'Send round to Pi (' + undeliveredCount + ' to send)' : 'Send round to Pi';
    }
    if (tally) {
      tally.hidden = all.length === 0;
      const counts = {
        open: all.filter((thread) => thread.status === 'open').length,
        'awaiting you': awaiting.length,
        'awaiting Pi': all.filter((thread) => thread.status === 'open' && !isAwaiting(thread) && thread.queued !== true && !(thread.pending > 0)).length,
        resolved: all.filter((thread) => thread.status === 'resolved').length,
        ...(queuedCount ? { queued: queuedCount } : {}),
        ...(pendingOnLive ? { pending: pendingOnLive } : {}),
      };
      tally.replaceChildren(...Object.entries(counts).map(([label, value]) => {
        const item = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = String(value);
        item.append(strong, document.createTextNode(' ' + label));
        return item;
      }));
    }
  };
  const upsertThread = (thread) => {
    threads.set(thread.id, thread);
    renderThread(thread);
    updateAggregates();
  };
  const flashTarget = (element) => {
    if (!element) return;
    document.querySelectorAll('.thread-flash').forEach((flashed) => flashed.classList.remove('thread-flash'));
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    void element.offsetWidth;
    element.classList.add('thread-flash');
  };
  // Keeping the focused thread in the URL fragment makes browser Back/refresh
  // land on the thread instead of the page default, and every focus shareable.
  const rememberThreadLocation = (id) => {
    try { window.history.replaceState(null, '', '#thread=' + id); } catch {}
  };
  const navigateStep = (direction) => {
    const awaiting = orderedAwaiting();
    if (!awaiting.length) {
      setStatus('Nothing awaiting you.');
      return;
    }
    if (!confirmDiscardDraft()) return;
    if (direction > 0) navIndex = (navIndex + 1) % awaiting.length;
    else navIndex = navIndex < 0 ? awaiting.length - 1 : (navIndex - 1 + awaiting.length) % awaiting.length;
    const thread = awaiting[navIndex];
    currentThreadId = thread.id;
    rememberThreadLocation(thread.id);
    if (thread.source === 'overview' || !thread.file) showOverview();
    else {
      const index = sectionIndexOf(thread);
      if (index >= 0 && index < fileSections.length) showFile(index);
    }
    let target = document.querySelector('[data-thread-card="' + thread.id + '"]');
    if (!target && thread.source === 'commentary') {
      const section = sectionForPath(thread.file);
      target = [...(section?.querySelectorAll('.agent-note') ?? [])].find((note) => note.dataset.commentaryId === thread.commentaryId);
    }
    flashTarget(target);
  };
  const navigateNext = () => navigateStep(1);
  const navigatePrev = () => navigateStep(-1);
  const resolveCurrent = () => {
    const thread = threads.get(currentThreadId);
    if (!thread) {
      setStatus('No current thread — press n to select one.');
      return;
    }
    if (thread.status === 'resolved') {
      setStatus('The current thread is already resolved.');
      return;
    }
    resolveThread(thread.id, true);
  };

  // Composers for Pi commentary and the overview -------------------------------
  document.querySelectorAll('[data-commentary-post]').forEach((button) => {
    const article = button.closest('.agent-note');
    const section = button.closest('[data-review-file]');
    const textarea = article.querySelector('[data-commentary-reply]');
    textarea.addEventListener('input', () => { button.disabled = !textarea.value.trim(); });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!button.disabled) {
        quietIntent = event.shiftKey;
        button.click();
      }
    });
    button.addEventListener('click', async () => {
      const quiet = consumeQuietIntent();
      const body = textarea.value.trim();
      if (!body) return;
      button.disabled = true;
      try {
        const result = await postJson(POST_PATH, { round: myRound, ...(quiet ? { quiet: true } : {}), source: 'commentary', file: section.dataset.path, commentaryId: button.dataset.commentaryPost, body });
        textarea.value = '';
        upsertThread(result.thread);
        postedStatus(result, 'Reply sent to Pi.');
      } catch (error) {
        button.disabled = false;
        setStatus(errorMessage(error), true);
      }
    });
  });
  document.querySelectorAll('[data-commentary-resolve]').forEach((button) => {
    const section = button.closest('[data-review-file]');
    button.addEventListener('click', () => {
      const thread = commentaryThreadFor(section.dataset.path, button.dataset.commentaryResolve);
      if (thread) resolveThread(thread.id, true);
      else setStatus('Threads are still loading — try again in a moment.', true);
    });
  });
  const overviewPost = document.querySelector('[data-overview-post]');
  const overviewTextarea = document.querySelector('[data-overview-feedback]');
  if (overviewPost && overviewTextarea) {
    overviewTextarea.addEventListener('input', () => { overviewPost.disabled = !overviewTextarea.value.trim(); });
    overviewTextarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!overviewPost.disabled) {
        quietIntent = event.shiftKey;
        overviewPost.click();
      }
    });
    overviewPost.addEventListener('click', async () => {
      const quiet = consumeQuietIntent();
      const body = overviewTextarea.value.trim();
      if (!body) return;
      overviewPost.disabled = true;
      try {
        const result = await postJson(POST_PATH, { round: myRound, ...(quiet ? { quiet: true } : {}), source: 'overview', body });
        overviewTextarea.value = '';
        upsertThread(result.thread);
        postedStatus(result, 'Feedback sent to Pi.');
      } catch (error) {
        overviewPost.disabled = false;
        setStatus(errorMessage(error), true);
      }
    });
  }

  // Anchored commentary jump ---------------------------------------------------
  document.querySelectorAll('.agent-note-anchor:not(:disabled)').forEach((button) => {
    button.addEventListener('click', () => {
      const note = button.closest('.agent-note, .carried-thread');
      const section = note.closest('[data-review-file]');
      const side = note.dataset.anchorSide;
      const line = note.dataset.anchorStart;
      const selector = side === 'old' ? `[data-old-line="${line}"]` : side === 'new' ? `[data-new-line="${line}"]` : `[data-old-line="${line}"], [data-new-line="${line}"]`;
      section.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // Viewed checklist -----------------------------------------------------------
  const viewedFiles = new Set([...document.querySelectorAll('[data-viewed-toggle]')].filter((box) => box.checked).map((box) => box.closest('[data-review-file]').dataset.path));
  const viewedBar = document.querySelector('[data-viewed-bar]');
  const viewedCountLabel = document.querySelector('[data-viewed-count]');
  const applyViewed = () => {
    fileSections.forEach((section) => {
      const box = section.querySelector('[data-viewed-toggle]');
      if (box) box.checked = viewedFiles.has(section.dataset.path);
    });
    document.querySelectorAll('[data-viewed-check]').forEach((mark) => { mark.hidden = !viewedFiles.has(mark.dataset.viewedCheck); });
    if (viewedBar) viewedBar.style.width = (fileSections.length ? Math.round((viewedFiles.size / fileSections.length) * 100) : 0) + '%';
    if (viewedCountLabel) viewedCountLabel.textContent = viewedFiles.size + ' / ' + fileSections.length + ' viewed';
  };
  const setViewed = async (path, viewed) => {
    if (isSuperseded()) return;
    if (viewed) viewedFiles.add(path);
    else viewedFiles.delete(path);
    applyViewed();
    try {
      await postJson(VIEWED_PATH, { round: myRound, file: path, viewed });
    } catch (error) {
      if (viewed) viewedFiles.delete(path);
      else viewedFiles.add(path);
      applyViewed();
      setStatus(errorMessage(error), true);
    }
  };
  document.querySelectorAll('[data-viewed-toggle]').forEach((box) => {
    box.addEventListener('change', () => setViewed(box.closest('[data-review-file]').dataset.path, box.checked));
  });
  document.querySelector('[data-shortcuts-hint]')?.addEventListener('click', () => {
    if (shortcutsOverlay) shortcutsOverlay.hidden = !shortcutsOverlay.hidden;
  });

  // Navigation wiring ----------------------------------------------------------
  document.querySelector('[data-overview-nav]')?.addEventListener('click', () => {
    if (showingOverview) return;
    if (!confirmDiscardDraft()) return;
    showOverview();
    setStatus('Discuss the change set or continue through the files.');
  });
  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!confirmDiscardDraft()) return;
      showFile(Number(button.dataset.fileNav));
      setStatus('Select changed code or reply to Pi.');
    });
  });
  inbox?.addEventListener('click', navigateNext);
  shortcutsOverlay?.addEventListener('click', (event) => {
    if (event.target === shortcutsOverlay) shortcutsOverlay.hidden = true;
  });
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const card = event.target.closest('[data-thread-card]');
    if (card) {
      currentThreadId = card.dataset.threadCard;
      rememberThreadLocation(currentThreadId);
      return;
    }
    const note = event.target.closest('.agent-note');
    if (note) {
      const thread = commentaryThreadFor(note.closest('[data-review-file]').dataset.path, note.dataset.commentaryId);
      if (thread) {
        currentThreadId = thread.id;
        rememberThreadLocation(currentThreadId);
      }
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (shortcutsOverlay && !shortcutsOverlay.hidden) {
        shortcutsOverlay.hidden = true;
        event.preventDefault();
        return;
      }
      const escaped = event.target;
      if (escaped instanceof HTMLElement && escaped.tagName === 'TEXTAREA') {
        escaped.blur();
        event.preventDefault();
      }
      return;
    }
    if (shortcutsOverlay && !shortcutsOverlay.hidden) {
      if (event.key === '?') {
        event.preventDefault();
        shortcutsOverlay.hidden = true;
      }
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'n') {
      event.preventDefault();
      navigateNext();
    } else if (event.key === 'N') {
      event.preventDefault();
      navigatePrev();
    } else if (event.key === 'e') {
      event.preventDefault();
      resolveCurrent();
    } else if (event.key === 'x') {
      event.preventDefault();
      const section = activeFile();
      if (section) setViewed(section.dataset.path, !viewedFiles.has(section.dataset.path));
    } else if (event.key === '?') {
      event.preventDefault();
      if (shortcutsOverlay) shortcutsOverlay.hidden = !shortcutsOverlay.hidden;
    }
  });

  // Live updates ----------------------------------------------------------------
  const focusHashThread = () => {
    const match = /(?:^#|[#&])thread=([A-Za-z0-9-]+)/.exec(window.location.hash || '');
    if (!match) return;
    const target = document.querySelector('[data-thread-card="' + match[1] + '"]') || document.querySelector('[data-carried-thread="' + match[1] + '"]');
    if (!target) return;
    const section = target.closest('[data-review-file]');
    if (section) showFile(Number(section.dataset.reviewFile));
    else showOverview();
    currentThreadId = match[1];
    flashTarget(target);
  };
  window.addEventListener('hashchange', focusHashThread);
  let deepLinked = false;
  const applyDeepLink = () => {
    if (deepLinked) return;
    deepLinked = true;
    focusHashThread();
  };
  const events = new EventSource(EVENTS_PATH + '?round=' + myRound);
  events.addEventListener('init', (event) => {
    const data = JSON.parse(event.data);
    if (loadedAsCurrent && data.currentRound > myRound) {
      // This tab was the active reviewer but slept through round-ready; catch up.
      autoNavigating = true;
      window.location.href = '/round/' + data.currentRound;
      return;
    }
    currentRound = data.currentRound;
    phase = data.phase;
    stale = Boolean(data.stale);
    applySessionState();
    threads.clear();
    for (const thread of data.threads) threads.set(thread.id, thread);
    for (const thread of data.threads) renderThread(thread);
    if (Array.isArray(data.viewedFiles)) {
      viewedFiles.clear();
      for (const path of data.viewedFiles) viewedFiles.add(path);
      applyViewed();
    }
    // A reconnect replays init; prune cards for threads deleted while this tab
    // was disconnected so no interactive stale card survives.
    document.querySelectorAll('[data-thread-card]').forEach((cardElement) => {
      if (!threads.has(cardElement.dataset.threadCard)) removeThread(cardElement.dataset.threadCard);
    });
    updateAggregates();
    applyDeepLink();
  });
  events.addEventListener('thread', (event) => {
    const data = JSON.parse(event.data);
    if (data.round !== myRound) return;
    const thread = data.thread;
    const previous = threads.get(thread.id);
    upsertThread(thread);
    const last = thread.turns[thread.turns.length - 1];
    if (last?.author === 'pi' && (previous?.turns.length ?? 0) < thread.turns.length) {
      setStatus('Pi replied — press n to view.');
    }
  });
  events.addEventListener('thread-removed', (event) => {
    const data = JSON.parse(event.data);
    if (data.round !== myRound) return;
    removeThread(data.threadId);
  });
  events.addEventListener('viewed', (event) => {
    const data = JSON.parse(event.data);
    if (data.round !== myRound) return;
    viewedFiles.clear();
    for (const path of data.viewedFiles) viewedFiles.add(path);
    applyViewed();
  });
  events.addEventListener('staleness', (event) => {
    stale = Boolean(JSON.parse(event.data).stale);
    applySessionState();
  });
  events.addEventListener('phase', (event) => {
    const data = JSON.parse(event.data);
    phase = data.phase;
    currentRound = data.currentRound;
    applySessionState();
    if (myRound === currentRound) setStatus(phase === 'revising' ? 'Pass sent — Pi is revising. Resume the round to keep commenting.' : 'Round ' + myRound + ' is live again — posting is unlocked.');
  });
  events.addEventListener('round-ready', (event) => {
    const data = JSON.parse(event.data);
    if (myRound === data.previousRound) {
      autoNavigating = true;
      window.location.href = '/round/' + data.round;
      return;
    }
    currentRound = data.round;
    phase = 'reviewing';
    applySessionState();
  });
  resumeButton?.addEventListener('click', async () => {
    try {
      await postJson(RESUME_PATH, {});
    } catch (error) {
      setStatus(errorMessage(error), true);
    }
  });
  applySessionState();

  // Finish pass -------------------------------------------------------------------
  finishButton.addEventListener('click', async () => {
    if (isLocked()) return;
    if (!confirmDiscardDraft()) return;
    const openCount = [...threads.values()].filter((thread) => thread.status === 'open').length;
    if (!window.confirm('Send this review pass to Pi?' + (openCount ? ' Open threads: ' + openCount + '.' : ''))) return;
    finishButton.disabled = true;
    const original = finishButton.textContent;
    finishButton.dataset.busy = '1';
    finishButton.textContent = 'Sending…';
    setStatus('Handing the pass to Pi…');
    try {
      const result = await postJson(FINISH_PATH, {});
      setStatus(result.stale ? 'Pass sent. Warning: the working tree changed after this snapshot.' : 'Pass sent — Pi is revising. Resume the round to keep commenting.');
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      finishButton.disabled = false;
      delete finishButton.dataset.busy;
      finishButton.textContent = original;
      updateAggregates();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    // Drafts on a superseded round are already dead; never block advancing past them.
    if (autoNavigating || isSuperseded()) return;
    const hasDraftText = draft || [...document.querySelectorAll('textarea')].some((textarea) => textarea.value.trim());
    if (!hasDraftText) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
