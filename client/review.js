(() => {
  const reviewRoot = document.getElementById('review-root');
  const submitButton = document.querySelector('[data-submit]');
  const globalStatus = document.querySelector('[data-global-status]');
  if (!reviewRoot || !submitButton || !globalStatus) return;

  const comments = [];
  const replies = new Map();
  const highlights = new Map();
  let nextId = 1;
  let activeIndex = 0;
  let draft;
  let submitted = false;

  const activeFile = () => reviewRoot.querySelector('[data-review-file="' + activeIndex + '"]');
  const setStatus = (message, error = false) => {
    globalStatus.textContent = message;
    globalStatus.style.color = error ? '#cf222e' : '';
  };
  const feedbackCount = () => comments.length + [...replies.values()].filter((value) => value.feedback.trim()).length;
  const updateSubmit = () => {
    submitButton.disabled = submitted || !!draft || feedbackCount() === 0 || comments.some((item) => !item.feedback.trim());
  };
  window.addEventListener('beforeunload', (event) => {
    if (submitted || (!draft && feedbackCount() === 0)) return;
    event.preventDefault();
    event.returnValue = '';
  });
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
    highlights.delete(draft.id);
    renderHighlights();
    const composer = activeFile()?.querySelector('[data-selection-composer]');
    if (composer) composer.hidden = true;
    draft = undefined;
    window.getSelection()?.removeAllRanges();
    updateSubmit();
  };
  const renderComments = () => {
    document.querySelectorAll('[data-user-comments]').forEach((root) => root.replaceChildren());
    for (const comment of comments) {
      const file = [...reviewRoot.querySelectorAll('[data-review-file]')].find((section) => section.dataset.path === comment.file);
      const root = file?.querySelector('[data-user-comments]');
      if (!root) continue;
      const card = document.createElement('article');
      card.className = 'user-comment';
      const quote = document.createElement('div');
      quote.className = 'user-comment-quote';
      quote.textContent = comment.highlight;
      const textarea = document.createElement('textarea');
      textarea.value = comment.feedback;
      textarea.setAttribute('aria-label', 'Feedback for ' + comment.file);
      textarea.addEventListener('input', () => { comment.feedback = textarea.value; updateSubmit(); });
      const actions = document.createElement('div');
      actions.className = 'composer-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        highlights.delete(comment.id);
        comments.splice(comments.indexOf(comment), 1);
        renderHighlights();
        renderComments();
        updateSubmit();
      });
      actions.append(remove);
      card.append(quote, textarea, actions);
      root.append(card);
    }
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
    if (submitted) return;
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
    const id = nextId++;
    highlights.set(id, pendingRange);
    if (!renderHighlights()) {
      highlights.delete(id);
      setStatus('Text highlighting is not supported by this browser.', true);
      return;
    }
    const oldLines = selected.rows.map((row) => Number(row.dataset.oldLine)).filter(Number.isInteger);
    const newLines = selected.rows.map((row) => Number(row.dataset.newLine)).filter(Number.isInteger);
    const kinds = new Set(selected.rows.map((row) => row.dataset.kind));
    const side = kinds.size === 1 && kinds.has('add') ? 'new' : kinds.size === 1 && kinds.has('del') ? 'old' : 'both';
    draft = {
      id,
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
    updateSubmit();
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
    add.addEventListener('click', () => {
      if (!draft || !textarea.value.trim()) return;
      comments.push({ ...draft, feedback: textarea.value.trim() });
      draft = undefined;
      composer.hidden = true;
      textarea.value = '';
      renderComments();
      updateSubmit();
      setStatus('Feedback ready to submit.');
    });
  });
  document.querySelectorAll('[data-commentary-reply]').forEach((textarea) => {
    const section = textarea.closest('[data-review-file]');
    const commentaryId = textarea.dataset.commentaryReply;
    const key = section.dataset.path + '\0' + commentaryId;
    textarea.addEventListener('input', () => {
      if (textarea.value.trim()) replies.set(key, { file: section.dataset.path, commentaryId, feedback: textarea.value });
      else replies.delete(key);
      updateSubmit();
    });
  });
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
  document.querySelectorAll('[data-file-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      if (submitted && button.dataset.fileNav === String(activeIndex)) return;
      if (draft && !window.confirm('Discard the unfinished diff comment?')) return;
      cancelDraft();
      activeIndex = Number(button.dataset.fileNav);
      document.querySelectorAll('[data-review-file]').forEach((section, index) => {
        section.hidden = index !== activeIndex;
        section.classList.toggle('active', index === activeIndex);
      });
      document.querySelectorAll('[data-file-nav]').forEach((item, index) => item.classList.toggle('active', index === activeIndex));
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  });
  submitButton.addEventListener('click', async () => {
    if (submitted || draft || submitButton.disabled) return;
    submitButton.disabled = true;
    submitButton.textContent = 'Submitting…';
    setStatus('Sending feedback to Pi…');
    try {
      const response = await fetch('/__pi_code_review_feedback__', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comments: comments.map(({ id, ...comment }) => comment),
          replies: [...replies.values()].map((reply) => ({ ...reply, feedback: reply.feedback.trim() })),
        }),
      });
      if (!response.ok) throw new Error(await response.text() || 'Submission failed');
      const result = await response.json();
      submitted = true;
      document.body.classList.add('submitted');
      document.querySelectorAll('textarea, button[data-selection-add], button[data-selection-cancel]').forEach((control) => { control.disabled = true; });
      submitButton.textContent = 'Submitted';
      setStatus(result.stale ? 'Feedback sent. Warning: the working tree changed after this snapshot.' : 'Feedback sent to Pi.');
    } catch (error) {
      submitButton.disabled = false;
      submitButton.textContent = 'Try again';
      setStatus(error instanceof Error ? error.message : 'Submission failed', true);
    }
  });
})();
