(() => {
  window.__AD_SLOTS = window.__AD_SLOTS || {};

  function fillAds() {
    if (typeof window === "undefined" || !window.adsbygoogle) {
      return;
    }

    document.querySelectorAll("ins.adsbygoogle").forEach((unit) => {
      if (unit.dataset.adStatus === "filled") return;
      const slotKey = unit.dataset.slotKey;
      if (slotKey && window.__AD_SLOTS[slotKey]) {
        unit.setAttribute("data-ad-slot", window.__AD_SLOTS[slotKey]);
      }
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        unit.dataset.adStatus = "filled";
      } catch (error) {
        console.warn("AdSense fill failed", error);
      }
    });
  }

  window.addEventListener("load", fillAds);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fillAds();
    }
  });
})();
