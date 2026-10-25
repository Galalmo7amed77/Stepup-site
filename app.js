/* ============================================================
   StepUp — منطق المتجر
   الكتالوج، السلة، التحقق من بيانات الطلب، وإرسال الطلب عبر واتساب.
   عادةً لا تحتاج لتعديل هذا الملف؛ عدّل المنتجات من products.js.
   ============================================================ */
(function () {
  'use strict';

  const CART_KEY = 'stepup_cart_v1';
  const PLACEHOLDER_IMAGE = 'images/placeholder.svg';
  const FORM_FIELDS = ['name', 'phone', 'altPhone', 'governorate', 'city', 'address'];

  const GOVERNORATES = [
    'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الغربية',
    'الدقهلية', 'المنوفية', 'البحيرة', 'كفر الشيخ', 'دمياط', 'بورسعيد',
    'الإسماعيلية', 'السويس', 'شمال سيناء', 'جنوب سيناء', 'البحر الأحمر',
    'مطروح', 'الفيوم', 'بني سويف', 'المنيا', 'أسيوط', 'سوهاج', 'قنا',
    'الأقصر', 'أسوان', 'الوادي الجديد'
  ];

  const moneyFormatter = new Intl.NumberFormat('ar-EG', {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 0
  });

  // ---------- قراءة الإعدادات والمنتجات ----------
  const getConfig = () => window.STEPUP_CONFIG || {};
  const getProducts = () => (Array.isArray(window.STEPUP_PRODUCTS) ? window.STEPUP_PRODUCTS : []);
  const getMaxQty = () => getConfig().maxQtyPerItem || 10;

  // ============================================================
  // دوال مساعدة نقية (بدون DOM) — يمكن اختبارها
  // ============================================================

  function formatPrice(amount) {
    return moneyFormatter.format(Number(amount) || 0);
  }

  // تحويل أي صيغة لرقم موبايل مصري إلى 01XXXXXXXXX، أو null لو غير صالح
  function normalizeEgyptPhone(input) {
    let s = String(input || '')
      .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632))
      .replace(/[\s\-().]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('0020')) s = s.slice(4);
    else if (s.length === 12 && s.startsWith('20')) s = s.slice(2);
    else if (s.startsWith('0')) s = s.slice(1);
    return /^1[0125]\d{8}$/.test(s) ? '0' + s : null;
  }

  function isSellable(product) {
    return !!product &&
      product.active === true &&
      Number(product.price) > 0 &&
      Array.isArray(product.sizes) &&
      product.sizes.length > 0;
  }

  function findProduct(id) {
    return getProducts().find(p => p.id === id && isSellable(p)) || null;
  }

  function isSizeOrderable(product, size) {
    return product.sizes.includes(size) && !(product.soldOutSizes || []).includes(size);
  }

  // تنظيف بيانات السلة المحفوظة: يحذف أي عنصر غير صالح أو منتج غير متاح
  function sanitizeCart(raw) {
    if (!Array.isArray(raw)) return [];
    const merged = new Map();
    raw.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const product = findProduct(String(entry.id));
      const size = Number(entry.size);
      const qty = Number(entry.qty);
      if (!product || !isSizeOrderable(product, size)) return;
      if (!Number.isInteger(qty) || qty < 1) return;
      const key = product.id + '|' + size;
      const current = merged.get(key);
      const newQty = Math.min((current ? current.qty : 0) + qty, getMaxQty());
      merged.set(key, { id: product.id, size: size, qty: newQty });
    });
    return [...merged.values()];
  }

  function addToCart(cart, id, size, qty) {
    const product = findProduct(id);
    if (!product) return { ok: false, error: 'هذا المنتج غير متاح حالياً.' };
    if (!size) return { ok: false, error: 'اختر المقاس أولاً قبل الإضافة إلى السلة.' };
    if (!isSizeOrderable(product, size)) return { ok: false, error: 'هذا المقاس غير متوفر.' };

    const existing = cart.find(i => i.id === id && i.size === size);
    const newQty = (existing ? existing.qty : 0) + qty;
    if (newQty > getMaxQty()) {
      return { ok: false, error: 'الحد الأقصى ' + getMaxQty() + ' قطع لكل مقاس.' };
    }
    if (existing) existing.qty = newQty;
    else cart.push({ id: id, size: size, qty: qty });
    return { ok: true, product: product };
  }

  function setCartQty(cart, id, size, qty) {
    const index = cart.findIndex(i => i.id === id && i.size === size);
    if (index === -1) return { ok: false, error: 'العنصر غير موجود في السلة.' };
    if (qty < 1) {
      cart.splice(index, 1);
      return { ok: true };
    }
    if (qty > getMaxQty()) return { ok: false, error: 'الحد الأقصى ' + getMaxQty() + ' قطع لكل مقاس.' };
    cart[index].qty = qty;
    return { ok: true };
  }

  function removeFromCart(cart, id, size) {
    const index = cart.findIndex(i => i.id === id && i.size === size);
    if (index !== -1) cart.splice(index, 1);
  }

  function cartTotals(cart) {
    const lines = cart
      .map(item => {
        const product = findProduct(item.id);
        if (!product) return null;
        return {
          item: item,
          product: product,
          unit: product.price,
          lineTotal: product.price * item.qty
        };
      })
      .filter(Boolean);
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const count = lines.reduce((sum, line) => sum + line.item.qty, 0);
    return { lines: lines, subtotal: subtotal, count: count };
  }

  // التحقق من بيانات الطلب — يعيد الأخطاء والقيم المنظّفة
  function validateCheckout(raw) {
    const errors = {};
    const name = String(raw.name || '').trim().replace(/\s+/g, ' ');
    const city = String(raw.city || '').trim();
    const address = String(raw.address || '').trim();
    const landmark = String(raw.landmark || '').trim();
    const notes = String(raw.notes || '').trim().slice(0, 500);

    if (name.length < 3) errors.name = 'اكتب اسمك بالكامل (٣ أحرف على الأقل).';

    const phone = normalizeEgyptPhone(raw.phone);
    if (!phone) errors.phone = 'اكتب رقم موبايل مصري صحيح، مثال: 01061160278';

    let altPhone = '';
    if (String(raw.altPhone || '').trim()) {
      altPhone = normalizeEgyptPhone(raw.altPhone) || '';
      if (!altPhone) errors.altPhone = 'رقم الواتساب البديل غير صحيح، أو احذفه إن لم يكن لديك.';
    }

    if (!GOVERNORATES.includes(raw.governorate)) errors.governorate = 'اختر المحافظة.';
    if (city.length < 2) errors.city = 'اكتب المدينة أو المركز.';
    if (address.length < 8) errors.address = 'اكتب العنوان بالتفصيل (الشارع ورقم العمارة).';

    return {
      errors: errors,
      values: {
        name: name,
        phone: phone || '',
        altPhone: altPhone,
        governorate: raw.governorate || '',
        city: city,
        address: address,
        landmark: landmark,
        notes: notes
      }
    };
  }

  // بناء رسالة الطلب بالعربية، جاهزة للإرسال من العميل
  function buildOrderMessage(customer, cart) {
    const totals = cartTotals(cart);
    const sep = '──────────────';
    const out = [];

    out.push('*طلب جديد من StepUp*');
    out.push(sep);
    out.push('*بيانات العميل*');
    out.push('الاسم: ' + customer.name);
    out.push('الهاتف: ' + customer.phone);
    if (customer.altPhone) out.push('واتساب بديل: ' + customer.altPhone);
    out.push('المحافظة: ' + customer.governorate);
    out.push('المدينة / المركز: ' + customer.city);
    out.push('العنوان: ' + customer.address);
    if (customer.landmark) out.push('علامة مميزة: ' + customer.landmark);
    out.push(sep);
    out.push('*المنتجات*');

    totals.lines.forEach((line, i) => {
      out.push((i + 1) + '. ' + line.product.nameAr);
      out.push('   المقاس: ' + line.item.size);
      out.push('   الكمية: ' + line.item.qty);
      out.push('   سعر القطعة: ' + formatPrice(line.unit));
      out.push('   الإجمالي: ' + formatPrice(line.lineTotal));
    });

    out.push(sep);
    out.push('الإجمالي الفرعي (قبل الشحن): ' + formatPrice(totals.subtotal));
    out.push('الشحن: لم تُؤكَّد تكلفته بعد، وسيتم تأكيدها عبر واتساب.');
    if (customer.notes) {
      out.push(sep);
      out.push('ملاحظات الطلب: ' + customer.notes);
    }
    return out.join('\n');
  }

  function buildWhatsAppUrl(number, message) {
    return 'https://wa.me/' + number + '?text=' + encodeURIComponent(message);
  }

  // ============================================================
  // أدوات واجهة المستخدم
  // ============================================================
  let cart = [];
  let els = {};
  let state = { category: 'all' };
  let activeProduct = null;
  let selectedSize = null;
  let selectedQty = 1;
  let revealObserver = null;
  let toastTimer = null;

  const $ = id => document.getElementById(id);

  // إنشاء عنصر DOM آمن (بدون innerHTML مع بيانات المستخدم)
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (value === false || value === null || value === undefined) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    });
    (children || []).forEach(child => node.append(child));
    return node;
  }

  function onImageError(event) {
    const img = event.currentTarget;
    if (img.dataset.fallback) return;
    img.dataset.fallback = '1';
    img.src = PLACEHOLDER_IMAGE;
  }

  function persistCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (e) {
      // التخزين غير متاح: السلة تعمل داخل الصفحة الحالية فقط
    }
  }

  function loadCart() {
    try {
      return sanitizeCart(JSON.parse(localStorage.getItem(CART_KEY) || '[]'));
    } catch (e) {
      return [];
    }
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  // ============================================================
  // الحركات (IntersectionObserver مع احتياطي آمن)
  // ============================================================
  function initReveal() {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!('IntersectionObserver' in window) || reduceMotion) return;
    revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    document.documentElement.classList.add('js-anim');
  }

  function observeReveal(nodes) {
    nodes.forEach(node => {
      if (revealObserver) revealObserver.observe(node);
      else node.classList.add('is-visible');
    });
  }

  // ============================================================
  // الكتالوج
  // ============================================================
  function orderableSizes(product) {
    return product.sizes.filter(size => isSizeOrderable(product, size));
  }

  function productImage(product, index) {
    const img = el('img', {
      src: product.image || PLACEHOLDER_IMAGE,
      alt: product.imageAlt || product.nameAr,
      width: 800,
      height: 1000,
      loading: index < 2 ? 'eager' : 'lazy',
      decoding: 'async'
    });
    img.addEventListener('error', onImageError);
    return img;
  }

  function productCard(product, index) {
    const available = orderableSizes(product);
    const media = el('button', {
      class: 'product-media',
      type: 'button',
      'aria-label': 'عرض تفاصيل ' + product.nameAr
    }, [
      productImage(product, index),
      product.isDemo ? el('span', { class: 'badge', text: 'نموذج تجريبي' }) : null
    ]);
    media.addEventListener('click', () => openProduct(product));

    const button = el('button', {
      class: 'btn btn-outline btn-block',
      type: 'button',
      disabled: available.length === 0,
      text: available.length ? 'اختر المقاس وأضف' : 'غير متوفر حالياً'
    });
    button.addEventListener('click', () => openProduct(product));

    const card = el('article', { class: 'product-card reveal' }, [
      media,
      el('div', { class: 'product-info' }, [
        el('p', { class: 'product-cat', text: product.category }),
        el('h3', { class: 'product-name', text: product.nameAr }),
        el('p', { class: 'product-price', text: formatPrice(product.price) }),
        el('p', {
          class: 'product-sizes',
          text: available.length ? 'المقاسات: ' + available.join('، ') : 'لا توجد مقاسات متاحة'
        }),
        button
      ])
    ]);
    card.style.setProperty('--i', String(Math.min(index, 6)));
    return card;
  }

  function visibleProducts() {
    const query = els.search.value.trim().toLowerCase();
    return getProducts()
      .filter(isSellable)
      .filter(p => state.category === 'all' || p.category === state.category)
      .filter(p => !query || [p.nameAr, p.descriptionAr, p.category].join(' ').toLowerCase().includes(query));
  }

  function renderCatalog() {
    const list = visibleProducts();
    els.grid.replaceChildren(...list.map(productCard));
    els.empty.hidden = list.length > 0;
    els.demoNote.hidden = !list.some(p => p.isDemo);
    observeReveal([...els.grid.querySelectorAll('.reveal')]);
  }

  function buildChips() {
    const categories = ['all', ...new Set(getProducts().filter(isSellable).map(p => p.category))];
    els.chips.replaceChildren(...categories.map(cat => {
      const chip = el('button', {
        class: 'chip',
        type: 'button',
        text: cat === 'all' ? 'الكل' : cat,
        dataset: { cat: cat }
      });
      chip.addEventListener('click', () => {
        state.category = cat;
        syncChips();
        renderCatalog();
      });
      return chip;
    }));
    syncChips();
  }

  function syncChips() {
    [...els.chips.children].forEach(chip => {
      chip.setAttribute('aria-pressed', String(chip.dataset.cat === state.category));
    });
  }

  // ============================================================
  // نافذة تفاصيل المنتج
  // ============================================================
  function openProduct(product) {
    activeProduct = product;
    selectedSize = null;
    selectedQty = 1;
    els.pdImg.src = product.image || PLACEHOLDER_IMAGE;
    els.pdImg.alt = product.imageAlt || product.nameAr;
    els.pdCat.textContent = product.category;
    els.pdName.textContent = product.nameAr;
    els.pdPrice.textContent = formatPrice(product.price);
    els.pdDesc.textContent = product.descriptionAr || '';
    els.pdDemo.hidden = !product.isDemo;
    renderSizeButtons();
    updateQtyDisplay();
    showProductError('');
    openDialog(els.productDialog);
  }

  function renderSizeButtons() {
    els.pdSizes.replaceChildren(...activeProduct.sizes.map(size => {
      const soldOut = !isSizeOrderable(activeProduct, size);
      const btn = el('button', {
        class: 'size-btn' + (soldOut ? ' is-sold-out' : ''),
        type: 'button',
        text: String(size),
        'aria-pressed': 'false',
        'aria-label': soldOut ? 'مقاس ' + size + ' — غير متوفر' : 'مقاس ' + size,
        disabled: soldOut,
        dataset: { size: size }
      });
      btn.addEventListener('click', () => {
        selectedSize = size;
        showProductError('');
        [...els.pdSizes.children].forEach(b => {
          b.setAttribute('aria-pressed', String(Number(b.dataset.size) === selectedSize));
        });
      });
      return btn;
    }));
  }

  function updateQtyDisplay() {
    els.qtyValue.textContent = String(selectedQty);
    els.qtyMinus.disabled = selectedQty <= 1;
    els.qtyPlus.disabled = selectedQty >= getMaxQty();
  }

  function showProductError(message) {
    els.pdError.textContent = message;
  }

  // ============================================================
  // السلة
  // ============================================================
  function renderCart() {
    const totals = cartTotals(cart);
    els.cartCount.textContent = String(totals.count);
    els.cartBody.replaceChildren();

    if (!totals.lines.length) {
      const continueBtn = el('button', { class: 'btn btn-outline', type: 'button', text: 'متابعة التسوق' });
      continueBtn.addEventListener('click', () => closeDialog(els.cartDrawer));
      els.cartBody.append(el('div', { class: 'empty-cart' }, [
        el('p', { text: 'سلتك فارغة حالياً.' }),
        continueBtn
      ]));
    } else {
      els.cartBody.append(el('ul', { class: 'cart-list' }, totals.lines.map(cartLine)));
    }

    els.cartSubtotal.textContent = formatPrice(totals.subtotal);
    els.cartFoot.hidden = totals.lines.length === 0;
    els.checkoutOpen.disabled = totals.lines.length === 0;
  }

  function cartLine(line) {
    const { item, product, unit, lineTotal } = line;
    const label = product.nameAr + ' — مقاس ' + item.size;

    const img = el('img', {
      src: product.image || PLACEHOLDER_IMAGE,
      alt: product.imageAlt || product.nameAr,
      width: 76,
      height: 95,
      loading: 'lazy'
    });
    img.addEventListener('error', onImageError);

    const minus = el('button', { type: 'button', text: '−', 'aria-label': 'تقليل كمية ' + label });
    const plus = el('button', { type: 'button', text: '+', 'aria-label': 'زيادة كمية ' + label });
    const qty = el('output', { text: String(item.qty), 'aria-label': 'الكمية' });
    minus.addEventListener('click', () => changeCartQty(item.id, item.size, item.qty - 1));
    plus.addEventListener('click', () => changeCartQty(item.id, item.size, item.qty + 1));
    minus.disabled = false;

    const remove = el('button', { class: 'link-btn', type: 'button', text: 'إزالة', 'aria-label': 'إزالة ' + label });
    remove.addEventListener('click', () => {
      removeFromCart(cart, item.id, item.size);
      persistCart();
      renderCart();
    });

    return el('li', { class: 'cart-line' }, [
      img,
      el('div', { class: 'line-info' }, [
        el('p', { class: 'line-name', text: product.nameAr }),
        el('p', { class: 'line-meta', text: 'المقاس: ' + item.size }),
        el('p', { class: 'line-meta', text: 'سعر القطعة: ' + formatPrice(unit) }),
        el('div', { class: 'line-controls' }, [
          el('div', { class: 'stepper' }, [minus, qty, plus]),
          remove
        ])
      ]),
      el('p', { class: 'line-total', text: formatPrice(lineTotal) })
    ]);
  }

  function changeCartQty(id, size, newQty) {
    const result = setCartQty(cart, id, size, newQty);
    if (!result.ok) {
      toast(result.error);
      return;
    }
    persistCart();
    renderCart();
  }

  function bumpCartCount() {
    els.cartCount.classList.remove('bump');
    void els.cartCount.offsetWidth; // إعادة تشغيل الحركة
    els.cartCount.classList.add('bump');
  }

  // ============================================================
  // الطلب عبر واتساب
  // ============================================================
  function populateGovernorates() {
    const placeholder = el('option', { value: '', text: 'اختر المحافظة' });
    const options = GOVERNORATES.map(g => el('option', { value: g, text: g }));
    els.governorate.replaceChildren(placeholder, ...options);
  }

  function field(name) {
    return els.checkoutForm.elements.namedItem(name);
  }

  function readCheckoutForm() {
    const raw = {};
    FORM_FIELDS.concat(['landmark', 'notes']).forEach(name => {
      raw[name] = field(name) ? field(name).value : '';
    });
    return raw;
  }

  function showFormErrors(errors) {
    FORM_FIELDS.forEach(name => {
      const message = errors[name] || '';
      const errorEl = $('e-' + name);
      if (errorEl) errorEl.textContent = message;
      field(name).setAttribute('aria-invalid', String(Boolean(message)));
    });
  }

  function openCheckout() {
    if (!cart.length) return;
    closeDialog(els.cartDrawer);
    els.waResult.hidden = true;
    openDialog(els.checkoutDialog);
  }

  function handleCheckoutSubmit(event) {
    event.preventDefault();
    cart = sanitizeCart(cart);
    persistCart();
    renderCart();

    if (!cart.length) {
      toast('السلة فارغة، أضف منتجاً أولاً.');
      closeDialog(els.checkoutDialog);
      return;
    }

    const result = validateCheckout(readCheckoutForm());
    showFormErrors(result.errors);
    const firstInvalid = FORM_FIELDS.find(name => result.errors[name]);
    if (firstInvalid) {
      field(firstInvalid).focus();
      return;
    }

    const message = buildOrderMessage(result.values, cart);
    const url = buildWhatsAppUrl(getConfig().whatsappInternational, message);
    els.waLink.href = url;
    const popup = window.open(url, '_blank');
    if (popup) {
      try { popup.opener = null; } catch (e) { /* تجاهل */ }
    }
    els.waResult.hidden = false;
    els.waResult.focus();
  }

  // ============================================================
  // ربط الأحداث والتهيئة
  // ============================================================
  function bindDialogBackdrop(dialog) {
    dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener('close', updateScrollLock);
    dialog.addEventListener('cancel', () => setTimeout(updateScrollLock, 0));
  }

  function updateScrollLock() {
    const anyOpen = [els.cartDrawer, els.checkoutDialog, els.productDialog].some(d => d.open);
    document.body.classList.toggle('no-scroll', anyOpen);
  }

  function bindEvents() {
    els.menuToggle.addEventListener('click', () => {
      const isOpen = els.menuToggle.getAttribute('aria-expanded') !== 'true';
      els.menuToggle.setAttribute('aria-expanded', String(isOpen));
      els.nav.classList.toggle('is-open', isOpen);
    });
    els.nav.addEventListener('click', event => {
      if (event.target.tagName === 'A') {
        els.menuToggle.setAttribute('aria-expanded', 'false');
        els.nav.classList.remove('is-open');
      }
    });

    window.addEventListener('scroll', () => {
      els.header.classList.toggle('is-scrolled', window.scrollY > 8);
    }, { passive: true });

    els.searchTrigger.addEventListener('click', () => {
      setTimeout(() => els.search.focus({ preventScroll: true }), 350);
    });
    els.search.addEventListener('input', renderCatalog);

    els.cartOpen.addEventListener('click', () => {
      renderCart();
      openDialog(els.cartDrawer);
      updateScrollLock();
    });
    els.cartClose.addEventListener('click', () => closeDialog(els.cartDrawer));
    els.checkoutOpen.addEventListener('click', openCheckout);
    els.continueShopping.addEventListener('click', () => closeDialog(els.cartDrawer));

    document.querySelectorAll('[data-close-dialog]').forEach(btn => {
      btn.addEventListener('click', () => closeDialog(btn.closest('dialog')));
    });

    els.qtyMinus.addEventListener('click', () => {
      selectedQty = Math.max(1, selectedQty - 1);
      updateQtyDisplay();
    });
    els.qtyPlus.addEventListener('click', () => {
      selectedQty = Math.min(getMaxQty(), selectedQty + 1);
      updateQtyDisplay();
    });

    els.pdAdd.addEventListener('click', () => {
      if (!selectedSize) {
        showProductError('اختر المقاس أولاً قبل الإضافة إلى السلة.');
        const firstAvailable = [...els.pdSizes.children].find(b => !b.disabled);
        if (firstAvailable) firstAvailable.focus();
        return;
      }
      const result = addToCart(cart, activeProduct.id, selectedSize, selectedQty);
      if (!result.ok) {
        showProductError(result.error);
        return;
      }
      persistCart();
      renderCart();
      bumpCartCount();
      toast('تمت إضافة ' + activeProduct.nameAr + ' (مقاس ' + selectedSize + ') إلى السلة');
      closeDialog(els.productDialog);
    });

    FORM_FIELDS.forEach(name => {
      field(name).addEventListener('input', () => {
        const errorEl = $('e-' + name);
        if (errorEl) errorEl.textContent = '';
        field(name).setAttribute('aria-invalid', 'false');
      });
    });
    els.checkoutForm.addEventListener('submit', handleCheckoutSubmit);

    [els.cartDrawer, els.checkoutDialog, els.productDialog].forEach(bindDialogBackdrop);
    els.pdImg.addEventListener('error', onImageError);
  }

  function cacheElements() {
    els = {
      header: $('site-header'),
      menuToggle: $('menu-toggle'),
      nav: $('site-nav'),
      searchTrigger: $('search-trigger'),
      search: $('search-input'),
      chips: $('category-chips'),
      grid: $('product-grid'),
      empty: $('empty-state'),
      demoNote: $('demo-note'),
      cartOpen: $('cart-open'),
      cartCount: $('cart-count'),
      cartDrawer: $('cart-drawer'),
      cartClose: $('cart-close'),
      cartBody: $('cart-body'),
      cartFoot: $('cart-foot'),
      cartSubtotal: $('cart-subtotal'),
      checkoutOpen: $('checkout-open'),
      continueShopping: $('continue-shopping'),
      productDialog: $('product-dialog'),
      pdImg: $('pd-img'),
      pdCat: $('pd-cat'),
      pdName: $('pd-name'),
      pdPrice: $('pd-price'),
      pdDesc: $('pd-desc'),
      pdDemo: $('pd-demo'),
      pdSizes: $('pd-sizes'),
      pdError: $('pd-error'),
      qtyMinus: $('qty-minus'),
      qtyPlus: $('qty-plus'),
      qtyValue: $('qty-value'),
      pdAdd: $('pd-add'),
      checkoutDialog: $('checkout-dialog'),
      checkoutForm: $('checkout-form'),
      governorate: $('f-governorate'),
      waResult: $('wa-result'),
      waLink: $('wa-link'),
      toast: $('toast')
    };
  }

  function init() {
    cacheElements();
    initReveal();
    populateGovernorates();
    buildChips();
    bindEvents();
    cart = loadCart();
    persistCart();
    renderCart();
    renderCatalog();
    observeReveal([...document.querySelectorAll('.reveal:not(.product-card)')]);
    $('year').textContent = String(new Date().getFullYear());
  }

  // تصدير الدوال النقية لاختبارها من الكونسول أو من ملفات الاختبار
  window.StepUpCore = {
    GOVERNORATES: GOVERNORATES,
    normalizeEgyptPhone: normalizeEgyptPhone,
    validateCheckout: validateCheckout,
    buildOrderMessage: buildOrderMessage,
    buildWhatsAppUrl: buildWhatsAppUrl,
    addToCart: addToCart,
    setCartQty: setCartQty,
    sanitizeCart: sanitizeCart,
    cartTotals: cartTotals,
    formatPrice: formatPrice
  };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
