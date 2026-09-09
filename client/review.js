(() => {
  const reviewRoot = document.getElementById('review-root');
  const finishButton = document.querySelector('[data-finish]');
  const globalStatus = document.querySelector('[data-global-status]');
  if (!reviewRoot || !finishButton || !globalStatus) return;

  const POST_PATH = '/__pi_code_review_post__';
  const RESOLVE_PATH = '/__pi_code_review_resolve__';
  const EVENTS_PATH = '/__pi_code_review_events__';
  const FINISH_PATH = '/__pi_code_review_finish__';

  const threads = new Map();
  const highlights = new Map();
  let nextHighlightId = 1;
  let draft;
  let nextPointer = 0;
  const overviewSection = reviewRoot.querySelector('[data-review-overview]');
  let showingOverview = Boolean(overviewSection);
  const fileSections = [...reviewRoot.querySelectorAll('[data-review-file]')];
  let activeIndex = Number(fileSections.find((section) => !section.hidden)?.dataset.reviewFile ?? 0);
  const navButtons = [...document.querySelectorAll('[data-file-nav]')];
  const inbox = document.querySelector('[data-inbox]');
  const tally = document.querySelector('[data-thread-tally]');

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
    else setStatus(message);
  };

  const isAwaiting = (thread) => thread.status === 'open' && thread.turns.length > 0 && thread.turns[thread.turns.length - 1].author === 'pi';
  const sectionForPath = (path) => fileSections.find((section) => section.dataset.path === path);
  const sectionIndexOf = (thread) => {
    if (thread.source === 'overview') return -1;
    const section = sectionForPath(thread.file);
    return section ? Number(section.dataset.reviewFile) : fileSections.length;
  };
  const threadNumber = (thread) => Number(thread.id.split('-t')[1]) || 0;
  const orderedAwaiting = () => [...threads.values()].filter(isAwaiting).sort((left, right) => sectionIndexOf(left) - sectionIndexOf(right) || threadNumber(left) - threadNumber(right));

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
      if (!add.disabled) add.click();
    });
    composer.querySelector('[data-selection-cancel]').addEventListener('click', cancelDraft);
    add.addEventListener('click', async () => {
      if (!draft || !textarea.value.trim() || add.dataset.busy) return;
      add.dataset.busy = '1';
      add.disabled = true;
      try {
        const result = await postJson(POST_PATH, {
          source: 'selection',
          file: draft.file,
          side: draft.side,
          ...(draft.oldStart === undefined ? {} : { oldStart: draft.oldStart, oldEnd: draft.oldEnd }),
          ...(draft.newStart === undefined ? {} : { newStart: draft.newStart, newEnd: draft.newEnd }),
          highlight: draft.highlight,
          body: textarea.value.trim(),
        });
        draft = undefined;
        composer.hidden = true;
        textarea.value = '';
        upsertThread(result.thread);
        postedStatus(result, 'Comment sent to Pi.');
      } catch (error) {
        add.disabled = false;
        setStatus(errorMessage(error), true);
      } finally {
        delete add.dataset.busy;
      }
    });
  });

  // Threads ------------------------------------------------------------------
  const threadHost = (thread) => {
    if (thread.source === 'overview') return document.querySelector('[data-overview-thread]');
    const section = sectionForPath(thread.file);
    if (!section) return undefined;
    if (thread.source === 'commentary') {
      return [...section.querySelectorAll('[data-commentary-thread]')].find((host) => host.dataset.commentaryThread === thread.commentaryId);
    }
    return section.querySelector('[data-selection-threads]');
  };
  const resolveThread = async (threadId, resolved) => {
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
    const previousReply = card?.querySelector('[data-thread-reply]');
    const previousDraft = previousReply?.value ?? '';
    const hadFocus = Boolean(previousReply) && document.activeElement === previousReply;
    const previousSelection = hadFocus ? [previousReply.selectionStart, previousReply.selectionEnd] : undefined;
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
    status.textContent = thread.status === 'resolved' ? 'Resolved' : awaiting ? 'Pi replied' : 'Waiting for Pi';
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
    const turns = thread.source === 'commentary' ? thread.turns.slice(1) : thread.turns;
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
        if (!send.disabled) send.click();
      });
      send.addEventListener('click', async () => {
        const body = textarea.value.trim();
        if (!body) return;
        send.disabled = true;
        textarea.value = '';
        try {
          const result = await postJson(POST_PATH, { threadId: thread.id, body });
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
    if (thread.source === 'commentary') {
      const section = sectionForPath(thread.file);
      const origin = [...(section?.querySelectorAll('[data-commentary-composer]') ?? [])].find((element) => element.dataset.commentaryComposer === thread.commentaryId);
      if (origin) origin.hidden = true;
    }
    if (thread.source === 'overview') {
      const origin = document.querySelector('[data-overview-composer]');
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
      if (thread.source === 'overview') overviewCount++;
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
    if (tally) {
      tally.hidden = all.length === 0;
      const counts = {
        open: all.filter((thread) => thread.status === 'open').length,
        'awaiting you': awaiting.length,
        'awaiting Pi': all.filter((thread) => thread.status === 'open' && !isAwaiting(thread)).length,
        resolved: all.filter((thread) => thread.status === 'resolved').length,
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
  const navigateNext = () => {
    const awaiting = orderedAwaiting();
    if (!awaiting.length) {
      setStatus('No threads awaiting you.');
      return;
    }
    if (!confirmDiscardDraft()) return;
    nextPointer = nextPointer % awaiting.length;
    const thread = awaiting[nextPointer++];
    if (thread.source === 'overview') showOverview();
    else {
      const index = sectionIndexOf(thread);
      if (index >= 0 && index < fileSections.length) showFile(index);
    }
    const card = document.querySelector('[data-thread-card="' + thread.id + '"]');
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('thread-flash');
      void card.offsetWidth;
      card.classList.add('thread-flash');
    }
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
      if (!button.disabled) button.click();
    });
    button.addEventListener('click', async () => {
      const body = textarea.value.trim();
      if (!body) return;
      button.disabled = true;
      try {
        const result = await postJson(POST_PATH, { source: 'commentary', file: section.dataset.path, commentaryId: button.dataset.commentaryPost, body });
        textarea.value = '';
        upsertThread(result.thread);
        postedStatus(result, 'Reply sent to Pi.');
      } catch (error) {
        button.disabled = false;
        setStatus(errorMessage(error), true);
      }
    });
  });
  const overviewPost = document.querySelector('[data-overview-post]');
  const overviewTextarea = document.querySelector('[data-overview-feedback]');
  if (overviewPost && overviewTextarea) {
    overviewTextarea.addEventListener('input', () => { overviewPost.disabled = !overviewTextarea.value.trim(); });
    overviewTextarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      if (!overviewPost.disabled) overviewPost.click();
    });
    overviewPost.addEventListener('click', async () => {
      const body = overviewTextarea.value.trim();
      if (!body) return;
      overviewPost.disabled = true;
      try {
        const result = await postJson(POST_PATH, { source: 'overview', body });
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
      const note = button.closest('.agent-note');
      const section = note.closest('[data-review-file]');
      const side = note.dataset.anchorSide;
      const line = note.dataset.anchorStart;
      const selector = side === 'old' ? `[data-old-line="${line}"]` : side === 'new' ? `[data-new-line="${line}"]` : `[data-old-line="${line}"], [data-new-line="${line}"]`;
      section.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    event.preventDefault();
    navigateNext();
  });

  // Live updates ----------------------------------------------------------------
  const events = new EventSource(EVENTS_PATH);
  events.addEventListener('init', (event) => {
    const data = JSON.parse(event.data);
    threads.clear();
    for (const thread of data.threads) threads.set(thread.id, thread);
    for (const thread of data.threads) renderThread(thread);
    updateAggregates();
  });
  events.addEventListener('thread', (event) => {
    const { thread } = JSON.parse(event.data);
    const previous = threads.get(thread.id);
    upsertThread(thread);
    const last = thread.turns[thread.turns.length - 1];
    if (last?.author === 'pi' && (previous?.turns.length ?? 0) < thread.turns.length) {
      setStatus('Pi replied — press n to view.');
    }
  });

  // Finish pass -------------------------------------------------------------------
  finishButton.addEventListener('click', async () => {
    if (!confirmDiscardDraft()) return;
    const openCount = [...threads.values()].filter((thread) => thread.status === 'open').length;
    if (!window.confirm('Send this review pass to Pi?' + (openCount ? ' Open threads: ' + openCount + '.' : ''))) return;
    finishButton.disabled = true;
    const original = finishButton.textContent;
    finishButton.textContent = 'Sending…';
    setStatus('Handing the pass to Pi…');
    try {
      const result = await postJson(FINISH_PATH, {});
      setStatus(result.stale ? 'Pass sent. Warning: the working tree changed after this snapshot.' : 'Review pass sent to Pi. Threads stay live.');
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      finishButton.disabled = false;
      finishButton.textContent = original;
    }
  });
  window.addEventListener('beforeunload', (event) => {
    const hasDraftText = draft || [...document.querySelectorAll('textarea')].some((textarea) => textarea.value.trim());
    if (!hasDraftText) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
