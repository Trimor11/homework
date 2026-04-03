(() => {
  window.__AD_SLOTS = window.__AD_SLOTS || {};

  const DESKTOP_QUERY = window.matchMedia ? window.matchMedia("(min-width: 768px)") : null;
  const adsEnabled = () => (DESKTOP_QUERY ? DESKTOP_QUERY.matches : true);

  function canFill(unit) {
    if (!unit || unit.dataset.adStatus === "filled") return false;
    const rect = unit.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 60;
  }

  function fillUnit(unit) {
    if (typeof window === "undefined" || !window.adsbygoogle) return;

    const slotKey = unit.dataset.slotKey;
    if (slotKey && window.__AD_SLOTS[slotKey]) {
      unit.setAttribute("data-ad-slot", window.__AD_SLOTS[slotKey]);
    }

    unit.dataset.adStatus = "loading";
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      unit.dataset.adStatus = "filled";
    } catch (error) {
      console.warn("AdSense fill failed", error);
      delete unit.dataset.adStatus;
    }
  }

  function scanAndFill() {
    if (!adsEnabled()) return;
    document.querySelectorAll("ins.adsbygoogle").forEach((unit) => {
      if (canFill(unit)) {
        fillUnit(unit);
      }
    });
  }

  const observer =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting && canFill(entry.target)) {
                fillUnit(entry.target);
              }
            });
          },
          { rootMargin: "200px 0px" }
        )
      : null;

  document.querySelectorAll("ins.adsbygoogle").forEach((unit) => {
    if (observer) observer.observe(unit);
  });

  if (DESKTOP_QUERY?.addEventListener) {
    DESKTOP_QUERY.addEventListener("change", (event) => {
      if (event.matches) {
        scanAndFill();
      }
    });
  } else if (DESKTOP_QUERY?.addListener) {
    DESKTOP_QUERY.addListener((event) => {
      if (event.matches) {
        scanAndFill();
      }
    });
  }

  window.addEventListener("load", scanAndFill, { once: true });
  window.addEventListener("resize", () => {
    requestAnimationFrame(scanAndFill);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scanAndFill();
    }
  });
})();
