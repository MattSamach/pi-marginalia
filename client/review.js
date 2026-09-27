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
  const CONTEXT_PATH = '/__pi_code_review_context__';
  const APPROVE_PATH = '/__pi_code_review_approve__';

  const myRound = Number(document.body.dataset.round || 1);
  let currentRound = Number(document.body.dataset.currentRound || myRound);
  let phase = document.body.dataset.phase || 'reviewing';
  const loadedAsCurrent = myRound === currentRound;
  let autoNavigating = false;
  const isSuperseded = () => myRound < currentRound;
  const isLocked = () => isSuperseded() || phase === 'approved';
  // While Pi revises, composing stays open but everything posts quietly —
  // queued for the next round. Live delivery, resolves, and passes wait.
  const quietOnly = () => phase === 'revising' && !isSuperseded();
  const effectiveQuiet = (quiet) => quiet === true || quietOnly();

  // Composer drafts survive reloads in localStorage, namespaced by snapshot id
  // (the origin is per-session — port included — so scope is naturally bounded).
  const DRAFT_NAMESPACE = 'picr:' + (document.body.dataset.reviewId || 'unknown') + ':';
  const draftKey = (name) => DRAFT_NAMESPACE + name;
  const saveDraft = (name, value) => {
    try {
      if (value && value.trim()) localStorage.setItem(draftKey(name), value);
      else localStorage.removeItem(draftKey(name));
    } catch {}
  };
  const readDraft = (name) => {
    try {
      return localStorage.getItem(draftKey(name)) ?? '';
    } catch {
      return '';
    }
  };
  const removeDraft = (name) => saveDraft(name, '');
  // Only the live current-round page prunes: superseded pages must never touch
  // the active round's namespace.
  if (loadedAsCurrent) {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('picr:') && !key.startsWith(DRAFT_NAMESPACE)) localStorage.removeItem(key);
      }
    } catch {}
  }

  const threads = new Map();
  // Hunk cursor: j/k and line permalinks ring a row; any file/overview switch
  // clears it so a stale ring never lingers on a hidden section.
  let hunkCursor;
  const clearHunkCursor = () => {
    hunkCursor?.classList.remove('nav-cursor');
    hunkCursor = undefined;
  };
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
  const approveButton = document.querySelector('[data-approve]');
  const approveOverlay = document.querySelector('[data-approve-overlay]');
  const approveMessage = document.querySelector('[data-approve-message]');
  const approveStale = document.querySelector('[data-approve-stale]');
  const planMode = document.body.dataset.reviewKind === 'plan';
  let stale = false;
  const staleBadgeBaseTitle = staleBadge?.title ?? '';
  // Amber sidebar dots on the files whose reviewed content drifted; paths
  // outside this review (files that joined the changeset) surface through the
  // badge tooltip, which lists every drifted path.
  let lastDriftPaths = [];
  const applyDriftMarks = (paths) => {
    if (paths !== undefined) lastDriftPaths = Array.isArray(paths) ? paths : [];
    // Marks obey the same suppression as the badge: drift is only signal while
    // this page shows the current round in the reviewing phase.
    const suppressed = !stale || phase !== 'reviewing' || isSuperseded();
    const drifted = new Set(suppressed ? [] : lastDriftPaths);
    document.querySelectorAll('[data-drift-mark]').forEach((mark) => {
      mark.hidden = !drifted.has(mark.dataset.driftMark);
    });
    if (staleBadge) staleBadge.title = drifted.size ? staleBadgeBaseTitle + ' Changed: ' + [...drifted].join(', ') : staleBadgeBaseTitle;
  };

  const applySessionState = () => {
    document.body.classList.toggle('locked', isLocked());
    document.body.classList.toggle('quiet-only', quietOnly());
    const quietLabels = quietOnly();
    document.querySelectorAll('[data-selection-add]').forEach((button) => {
      button.textContent = quietLabels ? 'Queue for next round' : 'Post comment';
    });
    document.querySelectorAll('[data-thread-send]').forEach((button) => {
      button.textContent = quietLabels ? 'Queue reply' : 'Reply';
    });
    document.querySelectorAll('[data-commentary-post]').forEach((button) => {
      button.textContent = quietLabels ? 'Queue reply' : 'Reply';
    });
    if (overviewPost) overviewPost.textContent = quietLabels ? 'Queue feedback' : overviewPostLabel;
    // Drift is expected while Pi revises and irrelevant on superseded rounds.
    if (staleBadge) staleBadge.hidden = !stale || phase !== 'reviewing' || isSuperseded();
    applyDriftMarks();
    syncDraftDot();
    document.querySelectorAll('[data-viewed-toggle]').forEach((box) => { box.disabled = isSuperseded(); });
    scheduleRailLayout();
    if (phaseBanner && phaseBannerText && resumeButton && gotoCurrent) {
      if (isSuperseded()) {
        phaseBanner.hidden = false;
        phaseBannerText.textContent = 'Round ' + myRound + ' is read-only — round ' + currentRound + ' is current.';
        resumeButton.hidden = true;
        gotoCurrent.hidden = false;
        gotoCurrent.href = '/round/' + currentRound;
      } else if (phase === 'approved') {
        phaseBanner.hidden = false;
        phaseBannerText.textContent = 'Approved — this review is closed. Pages stay readable.';
        resumeButton.hidden = true;
        gotoCurrent.hidden = true;
      } else if (phase === 'revising') {
        phaseBanner.hidden = false;
        phaseBannerText.textContent = 'Pi is revising — round ' + (myRound + 1) + ' pending. New comments queue for the next round; to post live on this round, resume it.';
        resumeButton.hidden = false;
        gotoCurrent.hidden = true;
      } else {
        phaseBanner.hidden = true;
      }
    }
    if (approveOverlay && phase !== 'reviewing' && !approveOverlay.hidden) approveOverlay.hidden = true;
    const finishDialog = document.querySelector('[data-finish-overlay]');
    if (finishDialog && phase !== 'reviewing' && !finishDialog.hidden) finishDialog.hidden = true;
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
    globalStatus.style.color = error ? 'var(--danger)' : '';
  };
  const errorMessage = (error) => (error instanceof Error ? error.message : 'Request failed');
  const postJson = async (path, payload) => {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error((await response.text()) || 'Request failed');
    return response.json();
  };
  const postedStatus = (result, message) => {
    if (result.deliveryFailed) setStatus('Posted, but delivery to Pi failed; it stays in this thread and the pass summary.', true);
    else if (result.queued) setStatus(quietOnly() ? 'Queued — arrives with the next round.' : 'Queued — delivered when you send the round.');
    else if (result.pending) setStatus(quietOnly() ? 'Pending — arrives with the next round.' : 'Pending — delivered with the round, a live reply, or Send now.');
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
    if (!thread.file) return -1;
    const section = sectionForPath(thread.file);
    return section ? Number(section.dataset.reviewFile) : fileSections.length;
  };
  const threadNumber = (thread) => Number(thread.id.split('-t')[1]) || 0;
  const orderedAwaiting = () => [...threads.values()].filter(isAwaiting).sort((left, right) => sectionIndexOf(left) - sectionIndexOf(right) || threadNumber(left) - threadNumber(right));
  const commentaryThreadFor = (file, commentaryId) => [...threads.values()].find((thread) => thread.source === 'commentary' && thread.file === file && thread.commentaryId === commentaryId);

  // Navigation ---------------------------------------------------------------
  const showOverview = () => {
    if (!overviewSection) return;
    clearHunkCursor();
    showingOverview = true;
    overviewSection.hidden = false;
    fileSections.forEach((section) => { section.hidden = true; section.classList.remove('active'); });
    document.querySelector('[data-overview-nav]')?.classList.add('active');
    navButtons.forEach((item) => item.classList.remove('active'));
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const planFocus = () => document.body.classList.contains('plan-focus');
  const showFile = (index) => {
    clearHunkCursor();
    showingOverview = false;
    if (overviewSection) overviewSection.hidden = true;
    document.querySelector('[data-overview-nav]')?.classList.remove('active');
    activeIndex = index;
    fileSections.forEach((section) => {
      const sectionIndex = Number(section.dataset.reviewFile);
      // The plan is one continuous document; sections never hide outside the
      // focus view (which hides by CSS on the active class instead).
      if (!planMode) section.hidden = sectionIndex !== index;
      section.classList.toggle('active', sectionIndex === index);
    });
    navButtons.forEach((item) => item.classList.toggle('active', Number(item.dataset.fileNav) === index));
    if (planMode && !planFocus()) document.querySelector('[data-review-file="' + index + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    // A section shown after being display-hidden skipped every layout that
    // ran while it had no boxes; refresh its rail now.
    scheduleRailLayout();
  };
  // The tie between a note and its text reads in both directions: hovering a
  // note tints the lines it anchors (blocks in plan mode, diff rows in code
  // mode); hovering a plan block outlines the notes that reference it.
  {
    let hoverMarked = [];
    const clearHoverMarks = () => {
      hoverMarked.forEach((element) => {
        element.classList.remove('note-target', 'note-hover');
        if (!draft || draft.elementTarget !== element) element.classList.remove('el-target');
      });
      hoverMarked = [];
    };
    const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aEnd >= bStart && aStart <= bEnd;
    document.addEventListener('mouseover', (event) => {
      if (!(event.target instanceof Element)) return;
      const note = event.target.closest('.agent-note[data-anchor-start], .carried-thread[data-anchor-start], .agent-note[data-anchor-element], .carried-thread[data-anchor-element]');
      const block = note || !planMode ? undefined : event.target.closest('.plan-doc [data-md-line]');
      clearHoverMarks();
      if (note) {
        noteAnchorTargets(note).forEach((candidate) => {
          candidate.classList.add(candidate.closest('svg') ? 'el-target' : 'note-target');
          hoverMarked.push(candidate);
        });
      } else if (block) {
        const section = block.closest('[data-review-file]');
        const start = Number(block.dataset.mdLine);
        const end = Number(block.dataset.mdEnd);
        section.querySelectorAll('.agent-note[data-anchor-start]').forEach((candidate) => {
          const noteStart = Number(candidate.dataset.anchorStart);
          const noteEnd = Number(candidate.dataset.anchorEnd || candidate.dataset.anchorStart);
          if (!rangesOverlap(noteStart, noteEnd, start, end)) return;
          candidate.classList.add('note-hover');
          hoverMarked.push(candidate);
        });
      }
    });
  }
  // Diagrams ------------------------------------------------------------------
  // Mermaid fences render client-side from the escaped source pre. Elements
  // gain data-el identities (node:x / edge:a->b) so clicks open the selection
  // composer refined to the element; zoom is ctrl/cmd-wheel plus buttons.
  const diagramElementIn = (section, reference) => section && section.querySelector('.diagram-canvas [data-el="' + (window.CSS && CSS.escape ? CSS.escape(reference) : reference) + '"]');
  const annotateDiagram = (svgRoot, parsed) => {
    svgRoot.querySelectorAll('g.node[id]').forEach((node) => {
      const match = /(?:^|-)([A-Za-z0-9_]+)-\d+$/.exec(node.id) || /(?:^|-)([A-Za-z0-9_]+)$/.exec(node.id);
      // Only elements the shared parser found are clickable: annotation and
      // server-side validation agree by construction.
      if (match && parsed.nodes.has(match[1])) node.dataset.el = 'node:' + match[1];
    });
    // Edge ids are L_<from>_<to>_<n> with a render prefix; ids may themselves
    // contain underscores, so cuts resolve against the parsed edge set first,
    // then the node set.
    svgRoot.querySelectorAll('path[id]').forEach((edge) => {
      const match = /(?:^|-)L_(.+)_(\d+)$/.exec(edge.id);
      if (!match) return;
      const middle = match[1];
      let fallback;
      for (let cut = middle.indexOf('_'); cut !== -1; cut = middle.indexOf('_', cut + 1)) {
        const from = middle.slice(0, cut);
        const to = middle.slice(cut + 1);
        if (parsed.edges.has(from + '->' + to)) {
          edge.dataset.el = 'edge:' + from + '->' + to;
          return;
        }
        if (!fallback && parsed.nodes.has(from) && parsed.nodes.has(to)) fallback = 'edge:' + from + '->' + to;
      }
      if (fallback) edge.dataset.el = fallback;
    });
  };
  let diagramPanConsumedClick = false;
  const setupDiagrams = async () => {
    const figures = [...document.querySelectorAll('[data-diagram]')];
    if (!figures.length) return;
    if (!window.mermaid) {
      figures.forEach((figure) => {
        figure.querySelector('.diagram-error').textContent = 'Diagram renderer unavailable.';
        figure.querySelector('.diagram-error').hidden = false;
        figure.querySelector('.diagram-source').hidden = false;
      });
      return;
    }
    // Diagrams render at natural size with legible type and NEVER scale
    // down — wide ones pan/scroll instead. The mermaid theme follows the
    // page's effective scheme so dark pages get dark diagrams.
    const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
    const effectiveDark = () => {
      const scheme = document.documentElement.dataset.scheme;
      return scheme === 'dark' || (scheme !== 'light' && darkQuery.matches);
    };
    const initializeMermaid = () => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: effectiveDark() ? 'dark' : 'neutral', fontFamily: 'system-ui, sans-serif', themeVariables: { fontSize: '16px' }, flowchart: { useMaxWidth: false }, state: { useMaxWidth: false }, er: { useMaxWidth: false }, sequence: { useMaxWidth: false } });
    initializeMermaid();
    let renderEpoch = 0;
    const renderAll = () => renderEpoch++ && figures.forEach((figure, index) => renderFigure(figure, index));
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', () => { initializeMermaid(); renderAll(); });
    document.querySelector('[data-scheme-picker]')?.addEventListener('change', () => { initializeMermaid(); renderAll(); });
    const renderFigure = async (figure, index) => {
      const source = figure.querySelector('.diagram-source').textContent;
      const canvas = figure.querySelector('[data-diagram-canvas]');
      try {
        const epoch = renderEpoch;
        const { svg } = await window.mermaid.render('picr-mmd-' + renderEpoch + '-' + index + '-' + figure.dataset.mdLine, source);
        if (epoch !== renderEpoch) return;
        const inner = document.createElement('div');
        inner.className = 'diagram-inner';
        inner.innerHTML = svg;
        canvas.replaceChildren(inner);
        // The rendered diagram replaces the source pre and changes the
        // section's height; reseat the margin rail against the new anchors.
        scheduleRailLayout();
        figure.classList.remove('diagram-scheme-light', 'diagram-scheme-dark');
        figure.classList.add(effectiveDark() ? 'diagram-scheme-dark' : 'diagram-scheme-light');
        const svgRoot = inner.querySelector('svg');
        if (svgRoot) {
          svgRoot.removeAttribute('style');
          if (typeof parseMermaidElements === 'function') annotateDiagram(svgRoot, parseMermaidElements(source));
          // Round diff: elements the server marked changed glow persistently.
          const changedRefs = figure.closest('[data-review-file]')?.dataset.changedElements;
          if (changedRefs) {
            for (const reference of changedRefs.split(' ')) {
              svgRoot.querySelectorAll('[data-el="' + (window.CSS && CSS.escape ? CSS.escape(reference) : reference) + '"]').forEach((element) => element.classList.add('el-changed'));
            }
          }
        }
        if (figure.dataset.zoomWired) return;
        figure.dataset.zoomWired = '1';
        const view = { scale: 1, x: 0, y: 0 };
        // Re-renders replace .diagram-inner, so the transform target is looked
        // up live rather than closed over.
        const apply = () => {
          const target = canvas.querySelector('.diagram-inner');
          if (target) target.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ')';
        };
        const zoomBy = (factor) => { view.scale = Math.min(4, Math.max(0.5, view.scale * factor)); if (view.scale === 1) { view.x = 0; view.y = 0; } apply(); };
        const controls = document.createElement('div');
        controls.className = 'diagram-zoom';
        [['+', () => zoomBy(1.25)], ['\u2212', () => zoomBy(0.8)], ['\u2922', () => { view.scale = 1; view.x = 0; view.y = 0; apply(); }]].forEach(([label, action]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.title = label === '+' ? 'Zoom in (or ctrl+wheel)' : label === '\u2212' ? 'Zoom out' : 'Reset view';
          button.addEventListener('click', action);
          controls.append(button);
        });
        figure.append(controls);
        canvas.addEventListener('wheel', (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.15 : 0.87);
        }, { passive: false });
        canvas.addEventListener('dblclick', (event) => {
          if (event.target.closest('[data-el]')) return;
          view.scale = 1; view.x = 0; view.y = 0; apply();
        });
        // Capture starts only after real movement: capturing on pointerdown
        // would retarget the click and kill element commenting while zoomed.
        let pan;
        canvas.addEventListener('pointerdown', (event) => {
          if (view.scale === 1 || event.button !== 0) return;
          pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX - view.x, y: event.clientY - view.y, moved: false };
        });
        canvas.addEventListener('pointermove', (event) => {
          if (!pan) return;
          if (!pan.moved && Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) < 4) return;
          if (!pan.moved) {
            pan.moved = true;
            canvas.setPointerCapture(pan.pointerId);
          }
          view.x = event.clientX - pan.x;
          view.y = event.clientY - pan.y;
          apply();
        });
        canvas.addEventListener('pointerup', () => {
          diagramPanConsumedClick = pan !== undefined && pan.moved;
          pan = undefined;
        });
      } catch (error) {
        figure.querySelector('.diagram-error').textContent = 'Diagram failed to render: ' + (error && error.message ? String(error.message).split('\n')[0] : 'unknown error');
        figure.querySelector('.diagram-error').hidden = false;
        figure.querySelector('.diagram-source').hidden = false;
        scheduleRailLayout();
        // Mermaid leaves its failed scratch element behind; drop it.
        document.querySelectorAll('[id^="dpicr-mmd-"]').forEach((scratch) => scratch.remove());
      }
    };
    for (const [index, figure] of figures.entries()) {
      await renderFigure(figure, index);
    }
    // Restored element drafts predate the async renders: mark them now.
    if (draft && draft.element && !draft.elementTarget) {
      const marked = diagramElementIn(sectionForPath(draft.file), draft.element);
      if (marked) {
        marked.classList.add('el-target');
        draft.elementTarget = marked;
      }
    }
    reviewRoot.addEventListener('click', (event) => {
      if (diagramPanConsumedClick) {
        diagramPanConsumedClick = false;
        return;
      }
      if (!(event.target instanceof Element)) return;
      const element = event.target.closest('.diagram-canvas [data-el]');
      if (!element || isLocked()) return;
      openElementComposer(element);
    });
  };
  const openElementComposer = (element) => {
    const figure = element.closest('[data-diagram]');
    const section = element.closest('[data-review-file]');
    if (!figure || !section) return;
    if (draft) {
      if (!window.confirm('Discard the unfinished comment?')) return;
      cancelDraft();
    }
    const reference = element.dataset.el;
    const label = reference.startsWith('node:')
      ? (element.querySelector('.nodeLabel, .label')?.textContent || reference.slice(5)).trim()
      : reference.slice(5).replace('->', ' \u2192 ');
    document.querySelectorAll('.diagram-canvas .el-target').forEach((marked) => marked.classList.remove('el-target'));
    element.classList.add('el-target');
    draft = {
      file: section.dataset.path,
      side: 'new',
      newStart: Number(figure.dataset.mdLine),
      newEnd: Number(figure.dataset.mdEnd || figure.dataset.mdLine),
      highlight: (reference.startsWith('node:') ? '\u2b21 ' : '\u2192 ') + label,
      element: reference,
      elementTarget: element,
    };
    const composer = section.querySelector('[data-selection-composer]');
    composer.hidden = false;
    stampComposerAnchor(composer, draft);
    scheduleRailLayout();
    composer.querySelector('[data-selection-quote]').textContent = draft.highlight;
    const textarea = composer.querySelector('[data-selection-feedback]');
    textarea.value = '';
    composer.querySelector('[data-selection-add]').disabled = true;
    window.getSelection()?.removeAllRanges();
    textarea.focus();
    saveSelectionDraft('');
    syncDraftDot();
    setStatus('Comment on ' + draft.highlight + '.');
  };
  if (planMode) setupDiagrams();

  // Reading-position tracking for the whole-document plan view: the sidebar
  // follows the section under the top of the viewport.
  if (planMode) {
    let spyPending = false;
    const followScroll = () => {
      spyPending = false;
      if (planFocus()) return;
      let best;
      // The document's ends belong to their end sections outright: a short
      // final section might never reach the viewport-top band (and a nav
      // click to it must not be overridden by the settling spy), and at the
      // very top the first section owns the view even when the next one's
      // heading grazes the band.
      if (window.scrollY <= 1) {
        best = fileSections[0];
      } else if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1) {
        best = fileSections[fileSections.length - 1];
      } else {
        for (const section of fileSections) {
          if (section.getBoundingClientRect().top <= 140) best = section;
          else break;
        }
      }
      if (!best || Number(best.dataset.reviewFile) === activeIndex) return;
      activeIndex = Number(best.dataset.reviewFile);
      fileSections.forEach((section) => section.classList.toggle('active', section === best));
      navButtons.forEach((item) => item.classList.toggle('active', Number(item.dataset.fileNav) === activeIndex));
    };
    window.addEventListener('scroll', () => {
      if (spyPending) return;
      spyPending = true;
      setTimeout(followScroll, 80);
    }, { passive: true });
    const viewToggle = document.querySelector('[data-view-toggle]');
    viewToggle?.addEventListener('click', () => {
      const focused = document.body.classList.toggle('plan-focus');
      viewToggle.textContent = focused ? 'Whole document' : 'Focus section';
      viewToggle.title = focused ? 'Show the whole document' : 'Show one section at a time';
      showFile(activeIndex);
      scheduleRailLayout();
    });
  }
  // Navigation never asks about drafts: an open draft survives every panel
  // switch (its composer stays live in its section, marked in the sidebar) and
  // persists across reloads. This confirm guards only the true destruction
  // points — replacing the draft, sending the round, and approving.
  const confirmDiscardDraft = () => {
    if (!draft) return true;
    if (!window.confirm('Discard the unfinished comment?')) return false;
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
  // With navigation prompt-free, an off-screen open draft announces itself
  // through a sidebar pencil on its host file.
  const syncDraftDot = () => {
    // On terminal or superseded pages the composer is unreachable for good, so
    // a pencil would point at nothing; while revising it stays — resume
    // revives the draft.
    const dead = phase === 'approved' || isSuperseded();
    document.querySelectorAll('[data-draft-dot]').forEach((dot) => {
      dot.hidden = dead || !draft || dot.dataset.draftDot !== draft.file;
    });
  };
  const cancelDraft = () => {
    if (!draft) return;
    if (draft.elementTarget) draft.elementTarget.classList.remove('el-target');
    highlights.delete(draft.highlightId);
    renderHighlights();
    const draftSection = sectionForPath(draft.file);
    const composer = draftSection?.querySelector('[data-selection-composer]');
    if (composer) composer.hidden = true;
    scheduleRailLayout();
    draft = undefined;
    removeDraft('selection');
    syncDraftDot();
    window.getSelection()?.removeAllRanges();
  };
  const saveSelectionDraft = (text) => {
    if (!draft) return;
    saveDraft('selection', JSON.stringify({ file: draft.file, side: draft.side, oldStart: draft.oldStart, oldEnd: draft.oldEnd, newStart: draft.newStart, newEnd: draft.newEnd, highlight: draft.highlight, element: draft.element, text: text ?? '' }));
  };
  // Rebuild a reloaded selection draft: composer, quote, anchor, and text —
  // without the visual text highlight, which needs a live selection range.
  const restoreSelectionDraft = () => {
    const saved = readDraft('selection');
    if (!saved || draft) return;
    let parsed;
    try {
      parsed = JSON.parse(saved);
    } catch {
      removeDraft('selection');
      return;
    }
    const section = sectionForPath(parsed.file);
    const composer = section?.querySelector('[data-selection-composer]');
    if (!composer || typeof parsed.highlight !== 'string') {
      removeDraft('selection');
      return;
    }
    draft = { highlightId: undefined, file: parsed.file, side: parsed.side, oldStart: parsed.oldStart, oldEnd: parsed.oldEnd, newStart: parsed.newStart, newEnd: parsed.newEnd, highlight: parsed.highlight, element: parsed.element };
    if (parsed.element) {
      const marked = diagramElementIn(section, parsed.element);
      if (marked) {
        marked.classList.add('el-target');
        draft.elementTarget = marked;
      }
    }
    composer.hidden = false;
    composer.querySelector('[data-selection-quote]').textContent = parsed.highlight;
    const textarea = composer.querySelector('[data-selection-feedback]');
    textarea.value = parsed.text ?? '';
    composer.querySelector('[data-selection-add]').disabled = !textarea.value.trim();
    // Land on the draft's file so the restored composer is visible; an
    // explicit deep link in the hash wins the navigation instead.
    if (!/(?:^#|[#&])(?:thread|loc)=/.test(window.location.hash || '')) showFile(Number(section.dataset.reviewFile));
    stampComposerAnchor(composer, draft);
    scheduleRailLayout();
    syncDraftDot();
  };
  // Plan documents anchor on rendered markdown blocks instead of diff rows;
  // each block carries its absolute source-line range.
  const planBlockAt = (section, line) => [...section.querySelectorAll('[data-md-line]')].find((block) => Number(block.dataset.mdLine) <= line && line <= Number(block.dataset.mdEnd));
  // Rail alignment: every card with a resolvable anchor sits beside the
  // content it annotates, GitHub-review style, in code mode and plan mode
  // alike. The pass positions cards absolutely inside the relative rail —
  // visual order can then follow the anchors while DOM order stays put for
  // the keyboard and screen readers, and removing one class drops everything
  // back to plain stacked flow. Cards compete for space in anchor order with
  // a minimum gap; anchorless cards (and cards whose anchors no longer
  // resolve) stack at the top of the rail before the anchored ones.
  const RAIL_GAP = 12;
  const RAIL_ITEM_SELECTOR = '.agent-note, .carried-thread, .thread-card, .selection-composer';
  // The outermost rail box around an element: commentary reply cards render
  // inside their note, so the nearest selector match may be nested.
  const railItemOf = (element) => {
    let item = element.closest(RAIL_ITEM_SELECTOR);
    for (let outer = item && item.parentElement?.closest(RAIL_ITEM_SELECTOR); outer; outer = item.parentElement?.closest(RAIL_ITEM_SELECTOR)) item = outer;
    return item ?? undefined;
  };
  // The card being interacted with — a focused composer or reply box, a
  // click, or the target of thread navigation — wins exact alignment; its
  // neighbors yield up or down around it.
  let priorityRailItem;
  const setPriorityRailItem = (element) => {
    if (!(element instanceof Element)) return;
    const item = railItemOf(element);
    if (!item || item === priorityRailItem || !item.closest('.commentary-column')) return;
    priorityRailItem = item;
    scheduleRailLayout();
  };
  // Where an item's anchor sits, in viewport coordinates; undefined keeps the
  // item in the top stack (outdated and omitted anchors resolve to nothing).
  const railAnchorY = (section, item) => {
    if (item.dataset.anchorElement !== undefined) {
      const element = diagramElementIn(section, item.dataset.anchorElement);
      if (element) return element.getBoundingClientRect().top;
    }
    const start = Number(item.dataset.anchorStart);
    if (!Number.isFinite(start) || start <= 0) return undefined;
    const end = Number(item.dataset.anchorEnd || item.dataset.anchorStart);
    const targets = anchorTargets(section, item.dataset.anchorSide, start, end);
    return targets.length ? targets[0].getBoundingClientRect().top : undefined;
  };
  const railResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleRailLayout()) : undefined;
  const observedRailItems = new WeakSet();
  const layoutRail = (section) => {
    const rail = section.querySelector('.commentary-column');
    if (!rail || rail.getClientRects().length === 0) return;
    const items = [...rail.querySelectorAll(RAIL_ITEM_SELECTOR)].filter((element) => railItemOf(element) === element && !element.hidden && element.getClientRects().length > 0);
    if (!items.length) {
      rail.classList.remove('rail-aligned');
      rail.style.minHeight = '';
      return;
    }
    // Absolute positioning engages before measuring so the in-flow furniture
    // (headings, summaries) reports its extent without the cards.
    rail.classList.add('rail-aligned');
    for (const item of items) {
      item.classList.add('rail-card');
      if (railResizeObserver && !observedRailItems.has(item)) {
        observedRailItems.add(item);
        railResizeObserver.observe(item);
      }
    }
    // Reads all happen before the writes: the pass costs at most two reflows
    // however many cards there are.
    const baseY = rail.getBoundingClientRect().top + rail.clientTop;
    let floor = 0;
    for (const child of rail.children) {
      if (child.classList.contains('rail-card')) continue;
      const box = child.getBoundingClientRect();
      if (box.height > 0) floor = Math.max(floor, box.bottom - baseY);
    }
    const stackTop = floor > 0 ? floor + RAIL_GAP : 0;
    const entries = items.map((item, order) => ({ item, order, height: item.offsetHeight, anchor: railAnchorY(section, item) }));
    // Anchorless cards stack first; anchored ones follow their anchors, DOM
    // order breaking ties so equal anchors keep their reading order.
    entries.sort((left, right) => {
      if ((left.anchor === undefined) !== (right.anchor === undefined)) return left.anchor === undefined ? -1 : 1;
      return (left.anchor ?? 0) - (right.anchor ?? 0) || left.order - right.order;
    });
    let cursor = stackTop;
    const tops = entries.map((entry) => {
      const top = entry.anchor === undefined ? cursor : Math.max(cursor, entry.anchor - baseY);
      cursor = top + entry.height + RAIL_GAP;
      return top;
    });
    const priorityIndex = priorityRailItem && priorityRailItem.isConnected && !priorityRailItem.hidden ? entries.findIndex((entry) => entry.item === priorityRailItem) : -1;
    const exact = priorityIndex >= 0 && entries[priorityIndex].anchor !== undefined ? Math.max(stackTop, entries[priorityIndex].anchor - baseY) : undefined;
    if (exact !== undefined && tops[priorityIndex] > exact + 0.5) {
      // The priority card sits exactly at its anchor: predecessors yield
      // upward as far as the top stack allows, a forward sweep restores the
      // minimum gap (moving the priority card only when there is genuinely
      // no room), and successors re-approach their own anchors.
      tops[priorityIndex] = exact;
      for (let index = priorityIndex - 1; index >= 0; index--) {
        tops[index] = Math.max(stackTop, Math.min(tops[index], tops[index + 1] - RAIL_GAP - entries[index].height));
      }
      for (let index = 1; index <= priorityIndex; index++) {
        tops[index] = Math.max(tops[index], tops[index - 1] + entries[index - 1].height + RAIL_GAP);
      }
      let after = tops[priorityIndex] + entries[priorityIndex].height + RAIL_GAP;
      for (let index = priorityIndex + 1; index < entries.length; index++) {
        tops[index] = entries[index].anchor === undefined ? after : Math.max(after, entries[index].anchor - baseY);
        after = tops[index] + entries[index].height + RAIL_GAP;
      }
    }
    let bottom = floor;
    entries.forEach((entry, index) => {
      entry.item.style.top = Math.round(tops[index]) + 'px';
      bottom = Math.max(bottom, tops[index] + entry.height);
    });
    // The rail grows to hold the lowest card so the section keeps room for it.
    const chrome = rail.offsetHeight - rail.clientHeight + (parseFloat(getComputedStyle(rail).paddingBottom) || 0);
    rail.style.minHeight = Math.ceil(bottom + chrome) + 'px';
  };
  const layoutRails = () => {
    document.querySelectorAll('[data-review-file]').forEach((section) => {
      try {
        layoutRail(section);
      } catch {
        // A failed pass must never strand invisible or overlapping cards:
        // this rail drops back to plain stacked flow.
        const rail = section.querySelector('.commentary-column');
        if (rail) {
          rail.classList.remove('rail-aligned');
          rail.style.minHeight = '';
        }
      }
    });
  };
  // Every layout trigger coalesces into one pass per animation frame.
  let railLayoutPending = false;
  const scheduleRailLayout = () => {
    if (railLayoutPending) return;
    railLayoutPending = true;
    requestAnimationFrame(() => {
      railLayoutPending = false;
      layoutRails();
    });
  };
  // Anything that can move an anchor or change a card's height reruns the
  // layout: rail and content-column resizes (window resizes land here too),
  // per-card resizes as a backstop, and explicit announcements from whatever
  // changes a card's content at runtime.
  if (railResizeObserver) {
    document.querySelectorAll('[data-review-file] .commentary-column, [data-review-file] .diff-column, [data-review-file] .plan-column').forEach((element) => railResizeObserver.observe(element));
  }
  document.addEventListener('marginalia:cards-resized', () => scheduleRailLayout());
  // The composer is a rail item like any card: it wears its draft's anchor so
  // the layout can seat it beside the selection.
  const stampComposerAnchor = (composer, pending) => {
    const start = pending.side === 'old' ? pending.oldStart : pending.newStart ?? pending.oldStart;
    const end = (pending.side === 'old' ? pending.oldEnd : pending.newEnd ?? pending.oldEnd) ?? start;
    if (start === undefined) {
      delete composer.dataset.anchorSide;
      delete composer.dataset.anchorStart;
      delete composer.dataset.anchorEnd;
    } else {
      composer.dataset.anchorSide = pending.side;
      composer.dataset.anchorStart = String(start);
      composer.dataset.anchorEnd = String(end);
    }
    if (pending.element) composer.dataset.anchorElement = pending.element;
    else delete composer.dataset.anchorElement;
  };
  const closestBlock = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-md-line]');
  const selectedBlocks = (range) => {
    const startBlock = closestBlock(range.startContainer);
    const endBlock = closestBlock(range.endContainer);
    const startSection = startBlock?.closest('[data-review-file]');
    const endSection = endBlock?.closest('[data-review-file]');
    if (!startBlock || !endBlock || !startSection || startSection !== endSection) return undefined;
    return {
      section: startSection,
      planStart: Math.min(Number(startBlock.dataset.mdLine), Number(endBlock.dataset.mdLine)),
      planEnd: Math.max(Number(startBlock.dataset.mdEnd), Number(endBlock.dataset.mdEnd)),
    };
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
    if (rows.some((row) => row.dataset.kind === 'expanded')) return { expanded: true };
    if (rows.some((row) => !['add', 'del', 'context'].includes(row.dataset.kind))) return undefined;
    return { section, rows };
  };
  const beginComment = () => {
    if (isLocked()) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const selected = planMode ? selectedBlocks(range) : selectedRows(range);
    if (!selected) {
      setStatus(planMode ? 'Select plan text within a single section.' : 'Select diff code within a single file.', true);
      return;
    }
    if (selected.expanded) {
      setStatus('Expanded context is read-only — anchor comments on the diff and its original context lines.', true);
      return;
    }
    const highlight = selection.toString().trim();
    if (!highlight) return;
    const pendingRange = range.cloneRange();
    if (draft) {
      if (!window.confirm('Discard the unfinished comment?')) {
        selection.removeAllRanges();
        return;
      }
      cancelDraft();
    }
    if ([...highlights.values()].some((existing) => overlaps(pendingRange, existing))) {
      setStatus(planMode ? 'Choose text that is not already highlighted.' : 'Choose code that is not already highlighted.', true);
      return;
    }
    const highlightId = nextHighlightId++;
    highlights.set(highlightId, pendingRange);
    if (!renderHighlights()) {
      highlights.delete(highlightId);
      setStatus('Text highlighting is not supported by this browser.', true);
      return;
    }
    if (planMode) {
      draft = { highlightId, file: selected.section.dataset.path, side: 'new', newStart: selected.planStart, newEnd: selected.planEnd, highlight };
    } else {
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
    }
    const composer = selected.section.querySelector('[data-selection-composer]');
    composer.hidden = false;
    stampComposerAnchor(composer, draft);
    scheduleRailLayout();
    composer.querySelector('[data-selection-quote]').textContent = highlight;
    const textarea = composer.querySelector('[data-selection-feedback]');
    textarea.value = '';
    composer.querySelector('[data-selection-add]').disabled = true;
    selection.removeAllRanges();
    textarea.focus();
    saveSelectionDraft('');
    syncDraftDot();
    setStatus(planMode ? 'Add feedback for the highlighted plan text.' : 'Add feedback for the highlighted diff.');
  };
  // Lazily reveal unchanged lines around hunks from the frozen snapshot's
  // pinned HEAD blob. Revealed rows are visual context only: they are not part
  // of the frozen diff, so they cannot anchor comment threads.
  const buildExpandedRow = (fileIndex, line) => {
    const row = document.createElement('tr');
    row.className = 'diff-line diff-context diff-expanded';
    row.dataset.fileIndex = String(fileIndex);
    row.dataset.kind = 'expanded';
    row.dataset.oldLine = String(line.old);
    row.dataset.newLine = String(line.new);
    const oldCell = document.createElement('td');
    oldCell.className = 'line-number';
    oldCell.textContent = String(line.old);
    const newCell = document.createElement('td');
    newCell.className = 'line-number';
    newCell.textContent = String(line.new);
    const marker = document.createElement('td');
    marker.className = 'line-marker';
    marker.setAttribute('aria-hidden', 'true');
    const code = document.createElement('td');
    code.className = 'diff-code';
    const span = document.createElement('span');
    span.textContent = line.content || '\u00a0';
    code.append(span);
    row.append(oldCell, newCell, marker, code);
    return row;
  };
  // Re-derive a finite divider's controls after a partial expansion: shrink
  // the note, keep the all-button count honest, and collapse to a single
  // reveal-all control once the remaining gap fits one click.
  const refreshExpander = (divider) => {
    const size = Number(divider.dataset.gapEnd) - Number(divider.dataset.gapStart) + 1;
    if (!Number.isFinite(size) || size <= 0) {
      divider.remove();
      return;
    }
    const note = divider.querySelector('.expander-note');
    if (note) note.textContent = size + ' unchanged line' + (size === 1 ? '' : 's');
    if (size <= 20) {
      divider.querySelectorAll('[data-expand]').forEach((button) => button.remove());
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.expand = 'all';
      button.textContent = '\u2195 ' + size;
      button.title = 'Show the hidden line' + (size === 1 ? '' : 's');
      divider.querySelector('.diff-code').prepend(button);
      return;
    }
    divider.querySelectorAll('[data-expand]').forEach((button) => {
      button.disabled = false;
      if (button.dataset.expand === 'all') button.textContent = '\u2195 ' + size;
    });
  };
  const expandContext = async (divider, mode) => {
    const section = divider.closest('[data-review-file]');
    const start = Number(divider.dataset.gapStart);
    const end = divider.dataset.gapEnd === undefined ? undefined : Number(divider.dataset.gapEnd);
    const from = mode === 'up' ? Math.max(end - 19, start) : start;
    const to = mode === 'all' ? end : mode === 'up' ? end : end === undefined ? start + 19 : Math.min(start + 19, end);
    const buttons = [...divider.querySelectorAll('[data-expand]')];
    buttons.forEach((button) => { button.disabled = true; });
    let payload;
    try {
      const response = await fetch(CONTEXT_PATH + '?round=' + myRound + '&path=' + encodeURIComponent(section.dataset.path) + '&oldStart=' + from + '&oldEnd=' + to);
      if (!response.ok) throw new Error((await response.text()) || 'Request failed');
      payload = await response.json();
    } catch (error) {
      buttons.forEach((button) => { button.disabled = false; });
      setStatus(errorMessage(error), true);
      return;
    }
    const rows = payload.lines.map((line) => buildExpandedRow(Number(divider.dataset.fileIndex), line));
    // Ascending row order relative to the divider: a top slice sits above it
    // (adjacent to the content before the gap), a bottom slice below it.
    if (mode === 'up') divider.after(...rows);
    else divider.before(...rows);
    if (mode === 'all' || payload.eof) {
      divider.remove();
      return;
    }
    if (end === undefined) {
      // Trailing gap of unknown length; the pinned blob may hold more.
      divider.dataset.gapStart = String(to + 1);
      buttons.forEach((button) => { button.disabled = false; });
      return;
    }
    if (mode === 'up') divider.dataset.gapEnd = String(from - 1);
    else divider.dataset.gapStart = String(to + 1);
    refreshExpander(divider);
  };
  reviewRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-expand]');
    if (!button || button.disabled) return;
    const divider = button.closest('[data-expander]');
    if (divider) void expandContext(divider, button.dataset.expand);
  });
  reviewRoot.addEventListener('mouseup', () => window.setTimeout(beginComment, 0));
  reviewRoot.addEventListener('keyup', (event) => {
    if (event.key === 'Shift' || event.key.startsWith('Arrow')) window.setTimeout(beginComment, 0);
  });
  document.querySelectorAll('[data-selection-composer]').forEach((composer) => {
    const textarea = composer.querySelector('[data-selection-feedback]');
    const add = composer.querySelector('[data-selection-add]');
    textarea.addEventListener('input', () => {
      add.disabled = !textarea.value.trim();
      saveSelectionDraft(textarea.value);
    });
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
          ...(effectiveQuiet(quiet) ? { quiet: true } : {}),
          source: 'selection',
          file: draft.file,
          side: draft.side,
          ...(draft.oldStart === undefined ? {} : { oldStart: draft.oldStart, oldEnd: draft.oldEnd }),
          ...(draft.newStart === undefined ? {} : { newStart: draft.newStart, newEnd: draft.newEnd }),
          ...(draft.element === undefined ? {} : { element: draft.element }),
          highlight: draft.highlight,
          body: textarea.value.trim(),
        });
        if (draft.highlightId !== undefined) threadHighlights.set(result.thread.id, draft.highlightId);
        if (draft.elementTarget) draft.elementTarget.classList.remove('el-target');
        draft = undefined;
        removeDraft('selection');
        syncDraftDot();
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

  // Theme picker: persists across sessions; the pre-paint head script applies
  // the saved choice before first render.
  document.querySelectorAll('[data-theme-picker], [data-scheme-picker]').forEach((select) => {
    const key = select.hasAttribute('data-theme-picker') ? 'theme' : 'scheme';
    select.value = document.documentElement.dataset[key] || (key === 'theme' ? 'slate' : 'auto');
    if (!select.value) select.value = key === 'theme' ? 'slate' : 'auto';
    select.addEventListener('change', () => {
      document.documentElement.dataset[key] = select.value;
      try {
        localStorage.setItem('picr-' + key, select.value);
      } catch (ignored) { /* private mode: theme lives for this page only */ }
    });
  });

  // Threads ------------------------------------------------------------------
  const threadHighlights = new Map();
  // Cards change height at runtime (reply composers expand and collapse,
  // resolved threads toggle between a compact row and full history); every
  // such change announces itself on the affected card so layout code can
  // react without polling.
  const cardsResized = (element) => {
    const card = element.closest('.thread-card, .agent-note, .carried-thread') ?? element;
    card.dispatchEvent(new CustomEvent('marginalia:cards-resized', { bubbles: true }));
  };
  // Idle reply composers read as a one-line Reply… affordance; the full box
  // appears while a draft is in progress and steps back when it holds nothing.
  const expandReplyComposer = (textarea, focus) => {
    const composer = textarea.closest('.reply-composer');
    if (composer && composer.classList.contains('collapsed')) {
      composer.classList.remove('collapsed');
      cardsResized(composer);
    }
    if (focus) textarea.focus();
  };
  const collapseReplyComposer = (textarea) => {
    const composer = textarea.closest('.reply-composer');
    if (!composer || composer.classList.contains('collapsed') || textarea.value.trim()) return;
    // Focus sitting in the composer (its own controls or the box itself)
    // means it is still in use.
    if (composer.contains(document.activeElement)) return;
    composer.classList.add('collapsed');
    cardsResized(composer);
  };
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const affordance = event.target.closest('[data-composer-expand]');
    const textarea = affordance ? affordance.closest('.reply-composer')?.querySelector('textarea') : undefined;
    if (textarea) expandReplyComposer(textarea, true);
  });
  // The rail layout positions cards by measurement, so any card height change
  // re-runs it: the marginalia:cards-resized listener plus the ResizeObserver
  // backstop wired next to layoutRail handle every dispatch from here.
  // The compact label naming what a thread anchors to: its diagram element or
  // its line range (side-aware in code mode, plain lines in plan mode).
  const anchorChipLabel = (thread) => {
    const elementRef = (thread.carried && thread.carried.element) || thread.element;
    if (elementRef) return elementRef.replace(/^node:/, '\u2b21 ').replace(/^edge:(.+)->(.+)$/, '$1 \u2192 $2');
    const anchor = thread.carried && thread.carried.startLine !== undefined ? thread.carried : thread;
    const start = anchor.startLine ?? (anchor.side === 'old' ? anchor.oldStart : anchor.newStart ?? anchor.oldStart);
    if (start === undefined) return undefined;
    const end = anchor.endLine ?? (anchor.side === 'old' ? anchor.oldEnd : anchor.newEnd ?? anchor.oldEnd) ?? start;
    const side = planMode || anchor.side === 'both' || anchor.side === undefined ? 'lines' : anchor.side + ' lines';
    return side + ' ' + start + (end !== start ? '\u2013' + end : '');
  };
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
    scheduleRailLayout();
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
      scheduleRailLayout();
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
    scheduleRailLayout();
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
      if (origin) {
        origin.hidden = false;
        // A freshly restored composer starts idle again unless it still holds
        // a draft.
        const reply = origin.querySelector('textarea');
        if (reply && !reply.value.trim()) origin.classList.add('collapsed');
      }
      scheduleRailLayout();
      return;
    }
    const previousReply = card?.querySelector('[data-thread-reply]');
    const previousReplyState = card?.querySelector('[data-reply-state]')?.dataset.replyState;
    const previousDraft = previousReply?.value ?? '';
    const hadFocus = Boolean(previousReply) && document.activeElement === previousReply;
    const previousSelection = hadFocus ? [previousReply.selectionStart, previousReply.selectionEnd] : undefined;
    const editorStates = new Map();
    card?.querySelectorAll('[data-turn-editor]').forEach((editor) => {
      editorStates.set(Number(editor.dataset.turnEditor), { value: editor.value, focus: document.activeElement === editor });
    });
    const freshCard = !card;
    const wasResolved = card?.classList.contains('resolved') === true;
    if (!card) {
      card = document.createElement('article');
      card.className = 'thread-card';
      card.dataset.threadCard = thread.id;
      // Cards wear their anchor so the rail layout can seat them beside the
      // content they annotate; carried shells already carry the anchor.
      const anchorStart = thread.startLine ?? (thread.side === 'old' ? thread.oldStart : thread.newStart ?? thread.oldStart);
      const anchorEnd = thread.endLine ?? (thread.side === 'old' ? thread.oldEnd : thread.newEnd ?? thread.oldEnd) ?? anchorStart;
      if (!thread.carried && anchorStart !== undefined) {
        card.dataset.anchorStart = String(anchorStart);
        card.dataset.anchorEnd = String(anchorEnd);
        if (thread.side) card.dataset.anchorSide = thread.side;
      }
      if (!thread.carried && thread.element) card.dataset.anchorElement = thread.element;
      const anchorLine = !thread.carried && anchorStart !== undefined ? anchorStart : undefined;
      if (thread.source === 'selection' && !thread.carried && anchorLine !== undefined) {
        // Rail cards sit in anchor order (both modes) so the layout can align
        // each one beside its content; the composer stays last.
        const successor = [...host.children].find((sibling) => sibling !== card && (sibling.matches('[data-selection-composer]') || (sibling.matches('[data-thread-card]') && Number(sibling.dataset.anchorStart) > anchorLine)));
        host.insertBefore(card, successor ?? null);
      } else if (planMode && host.matches('.plan-rail')) {
        // Anchorless strays (orphaned commentary threads) still keep the
        // composer as the rail's last child.
        host.insertBefore(card, host.querySelector('[data-selection-composer]'));
      } else if (!planMode && host.matches('[data-selection-threads]') && !thread.carried) {
        // Code-mode anchorless cards lead the rail (before anchored ones,
        // matching the alignment layout's top stack); anchored strays that
        // land here still file in ascending start-line order.
        const successor = [...host.children].find((sibling) => sibling.matches('[data-thread-card]') && (anchorLine === undefined ? sibling.dataset.anchorStart !== undefined : Number(sibling.dataset.anchorStart) > anchorLine));
        host.insertBefore(card, successor ?? null);
      } else {
        host.append(card);
      }
    }
    const awaiting = isAwaiting(thread);
    card.classList.toggle('awaiting', awaiting);
    card.classList.toggle('resolved', thread.status === 'resolved');
    card.replaceChildren();
    // Resolved threads read as one compact row (anchor chip, first message
    // truncated, resolved tick) with the full history behind a click on that
    // row. detail is the card itself while the thread stays open.
    // The enclosing agent-note (when the thread lives under one) collapses
    // with the thread: its body clamps to one line while the row is compact.
    const noteHost = card.closest('.agent-note');
    const syncNoteClamp = () => {
      noteHost?.classList.toggle('resolved-collapsed', thread.status === 'resolved' && card.dataset.resolvedOpen !== '1');
    };
    let detail = card;
    if (thread.status === 'resolved') {
      detail = document.createElement('div');
      detail.className = 'resolved-detail';
      detail.hidden = card.dataset.resolvedOpen !== '1';
      const summaryRow = document.createElement('button');
      summaryRow.type = 'button';
      summaryRow.className = 'resolved-summary';
      summaryRow.dataset.resolvedToggle = thread.id;
      summaryRow.title = 'Show or hide the resolved conversation';
      const chipLabel = anchorChipLabel(thread);
      if (chipLabel) {
        const chip = document.createElement('span');
        chip.className = 'anchor-chip';
        chip.textContent = chipLabel;
        summaryRow.append(chip);
      }
      // Same first turn the expanded card shows: commentary threads skip Pi's
      // note, which already renders in the agent-note above the card / except
      // when the note was resolved without a reply, where the note itself is
      // the only text the compact row can carry.
      const firstBody = (thread.source === 'commentary' && !thread.carried && !thread.heldFrom ? thread.turns[1] ?? thread.turns[0] : thread.turns[0])?.body ?? '';
      const first = document.createElement('span');
      first.className = 'resolved-first';
      first.textContent = firstBody.length > 80 ? firstBody.slice(0, 80) + '\u2026' : firstBody;
      const tick = document.createElement('span');
      tick.className = 'resolved-tick';
      tick.textContent = '\u2713';
      summaryRow.append(first, tick);
      summaryRow.addEventListener('click', () => {
        const open = card.dataset.resolvedOpen === '1';
        if (open) delete card.dataset.resolvedOpen;
        else card.dataset.resolvedOpen = '1';
        detail.hidden = open;
        syncNoteClamp();
        cardsResized(card);
      });
      card.append(summaryRow, detail);
    } else {
      delete card.dataset.resolvedOpen;
    }
    syncNoteClamp();
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
    detail.append(header);
    const chipRef = (thread.carried && thread.carried.element) || thread.element;
    if (chipRef) {
      const chip = document.createElement('span');
      chip.className = 'element-chip';
      chip.textContent = chipRef.replace(/^node:/, '\u2b21 ').replace(/^edge:(.+)->(.+)$/, '$1 \u2192 $2');
      status.after(chip);
    }
    if (thread.highlight) {
      const quote = document.createElement('div');
      quote.className = 'user-comment-quote';
      quote.textContent = thread.highlight;
      detail.append(quote);
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
      body.className = 'md';
      // renderMarkdown output is our own sanitized whitelist over fully escaped
      // input (shared/markdown.js, inlined by the server), safe for innerHTML.
      body.innerHTML = renderMarkdown(turn.body);
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
      detail.append(entry);
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
      detail.append(proposal);
    }
    if (thread.status === 'open') {
      const composer = document.createElement('div');
      composer.className = 'reply-composer';
      // Idle by default: only a card whose draft is in progress (text held or
      // box focused) keeps the full composer through a re-render.
      if (!previousDraft.trim() && !hadFocus) composer.classList.add('collapsed');
      const affordance = document.createElement('button');
      affordance.type = 'button';
      affordance.className = 'reply-affordance';
      affordance.dataset.composerExpand = '1';
      affordance.textContent = 'Reply\u2026';
      const textarea = document.createElement('textarea');
      textarea.maxLength = 20000;
      textarea.placeholder = 'Reply to Pi';
      textarea.dataset.threadReply = thread.id;
      textarea.value = previousDraft;
      const send = document.createElement('button');
      send.type = 'button';
      send.dataset.threadSend = thread.id;
      send.textContent = quietOnly() ? 'Queue reply' : 'Reply';
      send.disabled = !previousDraft.trim();
      textarea.addEventListener('input', () => {
        send.disabled = !textarea.value.trim();
        saveDraft('thread:' + thread.id, textarea.value);
        // A restored draft arrives through a synthetic input event; the box it
        // fills must be visible.
        if (textarea.value.trim()) expandReplyComposer(textarea);
      });
      // Collapsing back happens on blur only when the box is empty; a draft in
      // progress keeps its composer open. Deferred one tick so a click that
      // caused the blur lands before the collapse shifts layout under it.
      textarea.addEventListener('blur', () => window.setTimeout(() => collapseReplyComposer(textarea), 0));
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
          const result = await postJson(POST_PATH, { threadId: thread.id, body, ...(effectiveQuiet(quiet) ? { quiet: true } : {}) });
          // Sync storage to whatever the textarea holds NOW — clearing outright
          // would wipe a new draft typed while this send was in flight.
          saveDraft('thread:' + thread.id, card.querySelector('[data-thread-reply]')?.value ?? '');
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
      composer.append(affordance, textarea, sendRow);
      detail.append(composer);
      if (hadFocus) {
        textarea.focus();
        try { textarea.setSelectionRange(previousSelection[0], previousSelection[1]); } catch {}
      }
    }
    // Reply-state line: what Pi is doing with the thread's latest delivered
    // reviewer message. sent = handed off but queued until Pi settles;
    // working = in Pi's context with a turn in progress; seen = the turn ended
    // without a reply here. A Pi reply clears the state server-side, so
    // replied threads (and undelivered drafts) render nothing. Resolved
    // threads render no status line either — resolving closes the exchange,
    // so the line stays gated on open (it reappears on reopen because
    // renderThread re-runs on the status flip).
    if (thread.status === 'open' && ['sent', 'working', 'seen'].includes(thread.replyState)) {
      const replyState = document.createElement('div');
      replyState.className = 'reply-state';
      replyState.dataset.replyState = thread.replyState;
      const icon = document.createElement('span');
      icon.className = thread.replyState === 'seen' ? 'reply-tick' : 'reply-spinner';
      if (thread.replyState === 'seen') icon.textContent = '\u2713';
      replyState.append(icon, document.createTextNode(thread.replyState === 'seen' ? 'Seen' : thread.replyState === 'sent' ? 'Sent' : 'Pi is working\u2026'));
      card.append(replyState);
    }
    // Flipping between open and resolved swaps the full history for the
    // compact row (or back), changing the card's height.
    if (!freshCard && wasResolved !== (thread.status === 'resolved')) cardsResized(card);
    // The status line appearing, disappearing, or changing alters the card's
    // height; features that position against live card heights listen for this.
    if (card.querySelector('[data-reply-state]')?.dataset.replyState !== previousReplyState) {
      cardsResized(card);
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
      if (!thread.file) overviewCount++;
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
    if (approveButton) {
      const openCount = all.filter((thread) => thread.status === 'open').length;
      approveButton.hidden = isSuperseded();
      approveButton.textContent = openCount ? 'Approve (' + openCount + ' open)' : 'Approve';
      approveButton.title = openCount ? 'Every thread must be resolved before approving — click to jump to the first open thread' : 'Approve this review and close it';
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
    scheduleRailLayout();
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
    if (direction > 0) navIndex = (navIndex + 1) % awaiting.length;
    else navIndex = navIndex < 0 ? awaiting.length - 1 : (navIndex - 1 + awaiting.length) % awaiting.length;
    revealThread(awaiting[navIndex]);
  };
  const revealThread = (thread) => {
    currentThreadId = thread.id;
    rememberThreadLocation(thread.id);
    if (!thread.file) showOverview();
    else {
      const index = sectionIndexOf(thread);
      if (index >= 0 && index < fileSections.length) showFile(index);
    }
    let target = document.querySelector('[data-thread-card="' + thread.id + '"]') || document.querySelector('[data-carried-thread="' + thread.id + '"]');
    if (!target && thread.source === 'commentary') {
      const section = sectionForPath(thread.file);
      target = [...(section?.querySelectorAll('.agent-note') ?? [])].find((note) => note.dataset.commentaryId === thread.commentaryId);
    }
    // The revealed card wins alignment priority so it lands exactly beside
    // the anchor the scroll below brings into view.
    if (target) setPriorityRailItem(target);
    flashTarget(target);
    // Navigation lands the CODE on the thread's lines, not just the card: the
    // impacted area scrolls to the top band and flashes, exactly like an
    // anchor-label click.
    const section = sectionForPath(thread.file);
    if (section) {
      const elementRef = (thread.carried && thread.carried.element) || thread.element;
      const diagramTarget = elementRef === undefined ? undefined : diagramElementIn(section, elementRef);
      if (diagramTarget) {
        diagramTarget.closest('[data-diagram]').scrollIntoView({ behavior: 'smooth', block: 'start' });
        flashAnchorTargets([diagramTarget]);
        return;
      }
      const anchor = thread.carried && thread.carried.startLine !== undefined ? thread.carried : thread;
      const side = anchor.side;
      const start = anchor.startLine ?? (side === 'old' ? anchor.oldStart : anchor.newStart ?? anchor.oldStart);
      const end = anchor.endLine ?? (side === 'old' ? anchor.oldEnd : anchor.newEnd ?? anchor.oldEnd) ?? start;
      if (start !== undefined) {
        const lines = anchorTargets(section, side, start, end);
        if (lines.length) {
          lines[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
          flashAnchorTargets(lines);
        }
      }
    }
  };

  const stepHunk = (direction) => {
    const section = activeFile();
    if (!section) {
      setStatus('Open a file to walk its hunks — ] switches files.');
      return;
    }
    const hunks = [...section.querySelectorAll(planMode ? '[data-md-line]' : 'tr[data-kind="hunk"]')];
    if (!hunks.length) {
      setStatus(planMode ? 'This section has no blocks to walk.' : 'This file has no hunks to walk.');
      return;
    }
    const at = hunkCursor ? hunks.indexOf(hunkCursor) : -1;
    const next = at < 0
      ? (direction > 0 ? hunks[0] : hunks[hunks.length - 1])
      : hunks[(at + direction + hunks.length) % hunks.length];
    clearHunkCursor();
    hunkCursor = next;
    hunkCursor.classList.add('nav-cursor');
    hunkCursor.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const stepFile = (direction) => {
    if (!fileSections.length) return;
    const next = showingOverview
      ? (direction > 0 ? 0 : fileSections.length - 1)
      : (activeIndex + direction + fileSections.length) % fileSections.length;
    showFile(Number(fileSections[next]?.dataset.reviewFile ?? next));
    const path = fileSections.find((section) => Number(section.dataset.reviewFile) === activeIndex)?.dataset.path;
    if (path) setStatus(path);
  };
  const focusCurrentReply = () => {
    const thread = threads.get(currentThreadId);
    if (!thread) {
      setStatus('No current thread — press n to select one.');
      return;
    }
    revealThread(thread);
    const card = document.querySelector('[data-thread-card="' + thread.id + '"]');
    let reply = card?.querySelector('[data-thread-reply]');
    if (!reply && thread.source === 'commentary' && thread.commentaryId) {
      reply = sectionForPath(thread.file)?.querySelector('[data-commentary-reply="' + thread.commentaryId + '"]');
    }
    // Only open overview threads fall back to the general composer; a resolved
    // one must hit the resolved hint, not start an unrelated new thread.
    if (!reply && thread.source === 'overview' && thread.status === 'open') reply = document.querySelector('[data-overview-feedback]');
    if (reply && !reply.closest('[hidden]')) {
      // Keyboard reply navigation targets the box itself, so a collapsed
      // composer opens on the way in.
      expandReplyComposer(reply, true);
      setStatus('Replying — Esc returns to navigation.');
    } else setStatus(thread.status === 'resolved' ? 'The current thread is resolved — reopen it to reply.' : 'No reply box available for the current thread.');
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
    const commentaryDraftName = 'commentary:' + section.dataset.path + ':' + button.dataset.commentaryPost;
    textarea.addEventListener('input', () => {
      button.disabled = !textarea.value.trim();
      saveDraft(commentaryDraftName, textarea.value);
      // A restored draft arrives through a synthetic input event; the box it
      // fills must be visible.
      if (textarea.value.trim()) expandReplyComposer(textarea);
    });
    // Collapsing back happens on blur only when the box is empty; a draft in
    // progress keeps its composer open. Deferred one tick so a click that
    // caused the blur lands before the collapse shifts layout under it.
    textarea.addEventListener('blur', () => window.setTimeout(() => collapseReplyComposer(textarea), 0));
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
        const result = await postJson(POST_PATH, { round: myRound, ...(effectiveQuiet(quiet) ? { quiet: true } : {}), source: 'commentary', file: section.dataset.path, commentaryId: button.dataset.commentaryPost, body });
        textarea.value = '';
        removeDraft(commentaryDraftName);
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
  const overviewPostLabel = overviewPost?.textContent ?? 'Send';
  const overviewTextarea = document.querySelector('[data-overview-feedback]');
  if (overviewPost && overviewTextarea) {
    overviewTextarea.addEventListener('input', () => {
      overviewPost.disabled = !overviewTextarea.value.trim();
      saveDraft('overview', overviewTextarea.value);
    });
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
        const result = await postJson(POST_PATH, { round: myRound, ...(effectiveQuiet(quiet) ? { quiet: true } : {}), source: 'overview', body });
        overviewTextarea.value = '';
        removeDraft('overview');
        upsertThread(result.thread);
        postedStatus(result, 'Feedback sent to Pi.');
      } catch (error) {
        overviewPost.disabled = false;
        setStatus(errorMessage(error), true);
      }
    });
  }

  // Anchored commentary jump ---------------------------------------------------
  // The lines a note's anchor names: rendered blocks in plan mode, diff rows
  // in code mode (side-aware).
  const anchorTargets = (section, side, start, end) => {
    if (planMode) return [...section.querySelectorAll('[data-md-line]')].filter((block) => Number(block.dataset.mdEnd) >= start && Number(block.dataset.mdLine) <= end);
    const key = side === 'old' ? ['oldLine'] : side === 'new' ? ['newLine'] : ['oldLine', 'newLine'];
    return [...section.querySelectorAll('tr.diff-line')].filter((row) => key.some((name) => {
      const value = Number(row.dataset[name]);
      return Number.isInteger(value) && value >= start && value <= end;
    }));
  };
  const noteAnchorTargets = (note) => {
    const section = note.closest('[data-review-file]');
    if (!section) return [];
    const targets = [];
    if (note.dataset.anchorElement !== undefined) {
      const element = diagramElementIn(section, note.dataset.anchorElement);
      if (element) targets.push(element);
    }
    if (note.dataset.anchorStart !== undefined) {
      const start = Number(note.dataset.anchorStart);
      const end = Number(note.dataset.anchorEnd || note.dataset.anchorStart);
      targets.push(...anchorTargets(section, note.dataset.anchorSide, start, end));
    }
    return targets;
  };
  const flashAnchorTargets = (targets) => {
    document.querySelectorAll('.anchor-flash').forEach((element) => element.classList.remove('anchor-flash'));
    document.querySelectorAll('.el-flash').forEach((element) => element.classList.remove('el-flash'));
    targets.forEach((element) => {
      if (element.closest('svg')) {
        void element.getBoundingClientRect();
        element.classList.add('el-flash');
        element.addEventListener('animationend', () => element.classList.remove('el-flash'), { once: true });
        return;
      }
      void element.offsetWidth;
      element.classList.add('anchor-flash');
      element.addEventListener('animationend', () => element.classList.remove('anchor-flash'), { once: true });
    });
  };
  document.querySelectorAll('.agent-note-anchor:not(:disabled)').forEach((button) => {
    button.addEventListener('click', () => {
      const note = button.closest('.agent-note, .carried-thread');
      const targets = noteAnchorTargets(note);
      if (!targets.length) return;
      const svgTarget = Boolean(targets[0].closest('svg'));
      if (planMode && !svgTarget) {
        clearHunkCursor();
        hunkCursor = targets[0];
        targets[0].classList.add('nav-cursor');
      }
      // Land the lines near the top (scroll-margin supplies the padding), and
      // flash them so the eye finds the anchor immediately.
      (svgTarget ? targets[0].closest('[data-diagram]') : targets[0]).scrollIntoView({ behavior: 'smooth', block: 'start' });
      flashAnchorTargets(targets);
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

  // Approval --------------------------------------------------------------------
  approveButton?.addEventListener('click', () => {
    if (isLocked()) return;
    const blockers = [...threads.values()].filter((thread) => thread.status === 'open').sort((left, right) => sectionIndexOf(left) - sectionIndexOf(right) || threadNumber(left) - threadNumber(right));
    if (blockers.length) {
      setStatus(blockers.length + ' thread' + (blockers.length === 1 ? '' : 's') + ' still open — resolve every thread to approve.', true);
      revealThread(blockers[0]);
      return;
    }
    if (!approveOverlay) return;
    // Approval closes the session terminally; an unfinished draft dies with it.
    if (!confirmDiscardDraft()) return;
    if (approveStale) approveStale.hidden = !stale;
    approveOverlay.hidden = false;
    approveMessage?.focus();
  });
  document.querySelector('[data-approve-cancel]')?.addEventListener('click', () => {
    if (approveOverlay) approveOverlay.hidden = true;
  });
  approveOverlay?.addEventListener('click', (event) => {
    if (event.target === approveOverlay) approveOverlay.hidden = true;
  });
  document.querySelector('[data-approve-confirm]')?.addEventListener('click', async (event) => {
    const confirmButton = event.currentTarget;
    const message = approveMessage?.value.trim();
    if (!message) {
      setStatus('Approval requires a commit message.', true);
      return;
    }
    confirmButton.disabled = true;
    try {
      const result = await postJson(APPROVE_PATH, { message });
      if (approveOverlay) approveOverlay.hidden = true;
      setStatus(result.stale ? 'Approved — note the repository had drifted from this snapshot.' : 'Review approved.');
    } catch (error) {
      setStatus(errorMessage(error), true);
    }
    confirmButton.disabled = false;
  });

  // Navigation wiring ----------------------------------------------------------
  document.querySelector('[data-overview-nav]')?.addEventListener('click', () => {
    if (showingOverview) return;
    showOverview();
    setStatus('Discuss the change set or continue through the files.');
  });
  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      showFile(Number(button.dataset.fileNav));
      setStatus('Select changed code or reply to Pi.');
    });
  });
  inbox?.addEventListener('click', navigateNext);
  // Clicking anywhere inside a rail card makes it the alignment priority.
  reviewRoot.addEventListener('click', (event) => {
    if (event.target instanceof Element) setPriorityRailItem(event.target);
  });
  shortcutsOverlay?.addEventListener('click', (event) => {
    if (event.target === shortcutsOverlay) shortcutsOverlay.hidden = true;
  });
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    setPriorityRailItem(event.target);
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
      const finishDialog = document.querySelector('[data-finish-overlay]');
      if (finishDialog && !finishDialog.hidden) {
        finishDialog.hidden = true;
        event.preventDefault();
        return;
      }
      if (approveOverlay && !approveOverlay.hidden) {
        approveOverlay.hidden = true;
        event.preventDefault();
        return;
      }
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
    // Open dialogs own the keyboard: no navigation fires behind them, and
    // returning without preventDefault keeps Enter activating their buttons.
    if (approveOverlay && !approveOverlay.hidden) return;
    if (document.querySelector('[data-finish-overlay]:not([hidden])')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    // Outside a comment box, ⇧⌘⏎ opens the send-round confirmation; inside
    // one it stays quiet-add (the textarea guard above never lets it reach here).
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      openFinishModal();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Enter must keep activating focused controls; the reply shortcut is for
    // when focus rests on the page itself.
    if (event.key === 'Enter' && target instanceof HTMLElement && (target.tagName === 'BUTTON' || target.tagName === 'A' || target.tagName === 'SUMMARY' || target.tagName === 'SELECT')) return;
    if (event.key === 'j') {
      event.preventDefault();
      stepHunk(1);
    } else if (event.key === 'k') {
      event.preventDefault();
      stepHunk(-1);
    } else if (event.key === ']') {
      event.preventDefault();
      stepFile(1);
    } else if (event.key === '[') {
      event.preventDefault();
      stepFile(-1);
    } else if (event.key === 'o') {
      event.preventDefault();
      if (!overviewSection) setStatus('This review has no overview.');
      else if (!showingOverview) {
        showOverview();
        setStatus('Overview.');
      }
    } else if (event.key === 'r' || event.key === 'Enter') {
      event.preventDefault();
      focusCurrentReply();
    } else if (event.key === 'n') {
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
      // Plans have no viewed checklist; the key is inert there.
      const section = planMode ? undefined : activeFile();
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
  // Line permalinks: #loc=<path>:L<newLine> or :O<oldLine>. Clicking a line
  // number writes one; loading one navigates to the file and rings the row.
  const focusHashLocation = () => {
    const match = /(?:^#|[#&])loc=([^&]+)/.exec(window.location.hash || '');
    if (!match) return;
    let spec;
    try {
      spec = decodeURIComponent(match[1]);
    } catch {
      return;
    }
    const parts = /^(.*):(L|O)(\d+)$/.exec(spec);
    if (!parts) return;
    const section = sectionForPath(parts[1]);
    if (!section) {
      setStatus((planMode ? 'No section "' : 'No file "') + parts[1] + (planMode ? '" in this plan.' : '" in this review.'), true);
      return;
    }
    showFile(Number(section.dataset.reviewFile));
    const row = planMode
      ? (parts[2] === 'L' ? planBlockAt(section, Number(parts[3])) : undefined)
      : section.querySelector(parts[2] === 'L' ? 'tr[data-new-line="' + parts[3] + '"]' : 'tr[data-old-line="' + parts[3] + '"]');
    if (!row) {
      setStatus(planMode ? 'That line has no rendered block in this plan.' : 'That line is not visible in this diff — it may sit in an unexpanded gap.', true);
      return;
    }
    clearHunkCursor();
    hunkCursor = row;
    row.classList.add('nav-cursor');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const routeHash = () => {
    focusHashThread();
    focusHashLocation();
  };
  reviewRoot.addEventListener('click', (event) => {
    const cell = event.target.closest('td.line-number');
    if (!cell) return;
    const row = cell.closest('tr.diff-line');
    const section = row?.closest('[data-review-file]');
    if (!row || !section) return;
    const preferOld = cell === row.cells[0];
    const side = preferOld && row.dataset.oldLine ? 'O' : row.dataset.newLine ? 'L' : row.dataset.oldLine ? 'O' : undefined;
    const line = side === 'O' ? row.dataset.oldLine : row.dataset.newLine;
    if (!side || !line) return;
    try {
      window.history.replaceState(null, '', '#loc=' + encodeURIComponent(section.dataset.path) + ':' + side + line);
    } catch {}
    clearHunkCursor();
    hunkCursor = row;
    row.classList.add('nav-cursor');
    setStatus('Line link is in the address bar — copy to share.');
  });
  window.addEventListener('hashchange', routeHash);
  let deepLinked = false;
  const applyDeepLink = () => {
    if (deepLinked) return;
    deepLinked = true;
    routeHash();
  };
  let draftsRestored = false;
  const restoreDrafts = () => {
    if (draftsRestored) return;
    draftsRestored = true;
    const overviewSaved = readDraft('overview');
    const overviewBox = document.querySelector('[data-overview-feedback]');
    if (overviewBox && overviewSaved && !overviewBox.value) {
      overviewBox.value = overviewSaved;
      overviewBox.dispatchEvent(new Event('input'));
    }
    document.querySelectorAll('[data-commentary-reply]').forEach((textarea) => {
      const section = textarea.closest('[data-review-file]');
      if (!section || textarea.value) return;
      const saved = readDraft('commentary:' + section.dataset.path + ':' + textarea.dataset.commentaryReply);
      if (!saved) return;
      textarea.value = saved;
      textarea.dispatchEvent(new Event('input'));
    });
    // Thread replies restore once here — never inside renderThread, where a
    // mid-flight SSE re-render could resurrect a draft the send is clearing.
    document.querySelectorAll('[data-thread-reply]').forEach((textarea) => {
      if (textarea.value) return;
      const saved = readDraft('thread:' + textarea.dataset.threadReply);
      if (!saved) return;
      textarea.value = saved;
      textarea.dispatchEvent(new Event('input'));
    });
    restoreSelectionDraft();
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
    applyDriftMarks(data.driftPaths);
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
    restoreDrafts();
    scheduleRailLayout();
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
    const data = JSON.parse(event.data);
    stale = Boolean(data.stale);
    applyDriftMarks(data.driftPaths);
    applySessionState();
  });
  events.addEventListener('phase', (event) => {
    const data = JSON.parse(event.data);
    phase = data.phase;
    currentRound = data.currentRound;
    applySessionState();
    if (myRound === currentRound) setStatus(phase === 'approved' ? 'Review approved — this session is closed.' : phase === 'revising' ? 'Pass sent — Pi is revising. New comments queue for the next round.' : 'Round ' + myRound + ' is live again — posting is unlocked.');
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
  const finishOverlay = document.querySelector('[data-finish-overlay]');
  const openFinishModal = () => {
    // A send already in flight must not be re-confirmable through the chord;
    // the revising window has no pass to send either.
    if (isLocked() || quietOnly() || !finishOverlay || finishButton.dataset.busy) return;
    if (!confirmDiscardDraft()) return;
    const open = [...threads.values()].filter((thread) => thread.status === 'open');
    const undelivered = open.reduce((count, thread) => count + (thread.pending ?? 0), 0);
    const summary = finishOverlay.querySelector('[data-finish-summary]');
    if (summary) {
      summary.textContent = open.length
        ? open.length + ' open thread' + (open.length === 1 ? '' : 's') + (undelivered ? ' · ' + undelivered + ' unsent message' + (undelivered === 1 ? '' : 's') + ' will be delivered' : '') + ' — Pi responds to every open thread in the next round.'
        : 'No open threads — Pi receives the pass summary.';
    }
    finishOverlay.hidden = false;
    finishOverlay.querySelector('[data-finish-confirm]')?.focus();
  };
  const sendRound = async () => {
    if (finishOverlay) finishOverlay.hidden = true;
    finishButton.disabled = true;
    const original = finishButton.textContent;
    finishButton.dataset.busy = '1';
    finishButton.textContent = 'Sending…';
    setStatus('Handing the pass to Pi…');
    try {
      const result = await postJson(FINISH_PATH, {});
      setStatus(result.stale ? 'Pass sent. Warning: the working tree changed after this snapshot.' : 'Pass sent — Pi is revising. New comments queue for the next round.');
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      finishButton.disabled = false;
      delete finishButton.dataset.busy;
      finishButton.textContent = original;
      updateAggregates();
    }
  };
  finishButton.addEventListener('click', openFinishModal);
  document.querySelector('[data-finish-confirm]')?.addEventListener('click', () => void sendRound());
  document.querySelector('[data-finish-cancel]')?.addEventListener('click', () => {
    if (finishOverlay) finishOverlay.hidden = true;
  });
  finishOverlay?.addEventListener('click', (event) => {
    if (event.target === finishOverlay) finishOverlay.hidden = true;
  });
  window.addEventListener('beforeunload', (event) => {
    // Drafts on a superseded round are already dead; never block advancing past
    // them — and an approved session is terminal, so nothing left is a draft.
    if (autoNavigating || isSuperseded() || phase === 'approved') return;
    // Composer drafts persist to localStorage, so leaving loses nothing there;
    // only open queued-message editors hold unsaved content.
    const hasDraftText = [...document.querySelectorAll('[data-turn-editor]')].some((editor) => editor.value.trim());
    if (!hasDraftText) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
