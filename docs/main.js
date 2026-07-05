/* MKYADA product site — interactions */
(() => {
  "use strict";
  const doc = document.documentElement;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const SMALL = matchMedia("(max-width: 820px)").matches;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /* ---------- language (default EN; saved choice wins — bootstrapped in <head>) ---------- */
  function setLang(l) {
    doc.lang = l;
    try { localStorage.setItem("mkyada-lang", l); } catch (e) {}
  }
  window.toggleLang = () => setLang(doc.lang === "tr" ? "en" : "tr");

  /* ---------- word splitter (lang-span-safe) ---------- */
  if (!REDUCED) {
    document.querySelectorAll("[data-split]").forEach((el) => {
      const roots = el.querySelectorAll(":scope > span[lang]");
      (roots.length ? [...roots] : [el]).forEach((root) => {
        let i = 0; // independent stagger counter per language
        const walk = (node) => {
          [...node.childNodes].forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
              if (!child.textContent.trim()) return;
              const frag = document.createDocumentFragment();
              child.textContent.split(/(\s+)/).forEach((part) => {
                if (!part) return;
                if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(" ")); return; }
                const w = document.createElement("span");
                w.className = "w";
                const wi = document.createElement("span");
                wi.className = "wi";
                wi.textContent = part;
                wi.style.setProperty("--i", i++);
                w.appendChild(wi);
                frag.appendChild(w);
              });
              node.replaceChild(frag, child);
            } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== "BR") {
              walk(child);
            }
          });
        };
        walk(root);
      });
      el.classList.add("split-ready");
    });
    const h1 = document.querySelector("h1[data-split]");
    if (h1) setTimeout(() => h1.classList.add("split-now"), 150);
  }

  /* ---------- reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* stagger indices for [data-stagger] children */
  document.querySelectorAll("[data-stagger]").forEach((c) => {
    [...c.children].forEach((ch, i) => ch.style.setProperty("--i", i));
  });

  /* ---------- scroll scrub engine: writes --p (0..1) on [data-scrub] ---------- */
  const scrubs = [];
  document.querySelectorAll("[data-scrub]").forEach((el) => {
    const track = el.getAttribute("data-scrub") === "track";
    if (REDUCED || (track && SMALL)) return; // CSS fallbacks take over
    scrubs.push({ el, track, steps: +el.dataset.steps || 0, last: -1, active: false });
  });

  function computeScrub(s, vh) {
    const r = s.el.getBoundingClientRect();
    const p = s.track
      ? clamp01(-r.top / Math.max(1, r.height - vh))
      : clamp01((vh - r.top) / (vh + r.height));
    s.el.style.setProperty("--p", p.toFixed(4));
    if (s.steps) {
      const st = Math.min(s.steps - 1, Math.floor(p * s.steps));
      if (st !== s.last) { s.last = st; s.el.dataset.step = st; }
    }
  }

  if (scrubs.length) {
    const sio = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const s = scrubs.find((x) => x.el === e.target);
        if (s) s.active = e.isIntersecting;
      }
    }, { rootMargin: "30% 0px 30% 0px" });
    scrubs.forEach((s) => sio.observe(s.el));
    scrubs.forEach((s) => computeScrub(s, innerHeight)); // prime before first scroll
  }

  /* ---------- frame loop: scrubs + nav hide/show + progress bar ---------- */
  const nav = document.querySelector("nav");
  let lastY = -1;
  addEventListener("resize", () => { lastY = -1; }, { passive: true });
  function frame() {
    const y = scrollY, vh = innerHeight;
    if (y !== lastY) {
      if (nav && !REDUCED) nav.classList.toggle("hide", y > 280 && y > lastY);
      const max = doc.scrollHeight - vh;
      doc.style.setProperty("--sp", max > 0 ? (y / max).toFixed(4) : "0");
      for (const s of scrubs) if (s.active) computeScrub(s, vh);
      lastY = y;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- 3D tilt + specular shine ---------- */
  if (FINE && !REDUCED) {
    document.querySelectorAll(".tilt").forEach((tilt) => {
      const inner = tilt.querySelector(".tilt-inner");
      if (!inner) return;
      let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
      const step = () => {
        cx += (tx - cx) * 0.12;
        cy += (ty - cy) * 0.12;
        inner.style.transform = `rotateX(${cy.toFixed(3)}deg) rotateY(${cx.toFixed(3)}deg)`;
        if (Math.abs(cx - tx) > 0.02 || Math.abs(cy - ty) > 0.02) raf = requestAnimationFrame(step);
        else raf = 0;
      };
      const kick = () => { if (!raf) raf = requestAnimationFrame(step); };
      tilt.addEventListener("pointermove", (ev) => {
        const r = tilt.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width;
        const py = (ev.clientY - r.top) / r.height;
        tx = (px - 0.5) * 14;
        ty = (0.5 - py) * 10;
        inner.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
        inner.style.setProperty("--my", (py * 100).toFixed(1) + "%");
        kick();
      });
      tilt.addEventListener("pointerleave", () => { tx = 0; ty = 0; kick(); });
    });

    /* cursor glow on cards */
    document.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", (ev.clientX - r.left) + "px");
        card.style.setProperty("--my", (ev.clientY - r.top) + "px");
      });
    });
  }

  /* ---------- 3D keypad: auto-typing while visible, pressable ---------- */
  const plate = document.querySelector(".k3d-plate");
  if (plate) {
    const keys = [...plate.querySelectorAll(".k3d-key")];
    const press = (k) => {
      k.classList.add("pressed");
      setTimeout(() => k.classList.remove("pressed"), 170);
    };
    keys.forEach((k) => k.addEventListener("pointerdown", () => press(k)));
    if (!REDUCED && keys.length) {
      const seq = [4, 0, 8, 2, 6, 1, 5, 3, 7];
      let idx = 0, timer = 0;
      const tio = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !timer) {
            timer = setInterval(() => press(keys[seq[idx++ % seq.length] % keys.length]), 460);
          } else if (!e.isIntersecting && timer) {
            clearInterval(timer);
            timer = 0;
          }
        }
      }, { threshold: 0.4 });
      tio.observe(plate);
    }
  }

  /* ---------- spec counters ---------- */
  if (!REDUCED) {
    const cio = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cio.unobserve(e.target);
        const el = e.target;
        const end = +el.dataset.count;
        const pre = el.dataset.prefix || "";
        const suf = el.dataset.suffix || "";
        const t0 = performance.now(), dur = 1300;
        const tick = (now) => {
          let t = Math.min(1, (now - t0) / dur);
          t = 1 - Math.pow(1 - t, 3);
          el.textContent = pre + Math.round(end * t) + suf;
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }, { threshold: 0.6 });
    document.querySelectorAll("[data-count]").forEach((el) => cio.observe(el));
  }
})();
