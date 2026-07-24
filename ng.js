// ==UserScript==
// @name         lis-skins-profit-calculator
// @namespace    http://tampermonkey.net
// @version      19.19
// @description  lis-skins-profit-calculator
// @author       p0pye + AI Helper
// @match        https://lis-skins.com/*/market/*
// @match        https://avan.market/market*
// @match        https://avan.market/*/market*
// @match        https://steam-trader.net/*
// @match        https://www.steam-trader.net/*
// @match        https://keys-store.com/skins/*
// @match        https://www.keys-store.com/skins/*
// @match        https://tradeit.gg/*/csgo/store*
// @match        https://tradeit.gg/*/rust/store*
// @match        https://tradeit.gg/*/tf2/store*
// @match        https://tradeit.gg/*/steam/store*
// @match        https://tradeit.gg/csgo/store*
// @match        https://tradeit.gg/rust/store*
// @match        https://tradeit.gg/tf2/store*
// @match        https://tradeit.gg/steam/store*
// @match        https://tradeit.gg/*store*
// @match        https://www.tradeit.gg/*store*
// @match        https://skinport.com/*
// @match        https://www.skinport.com/*
// @match        https://waxpeer.com/*
// @match        https://www.waxpeer.com/*
// @match        https://moon.market/*
// @match        https://www.moon.market/*
// @icon         https://www.google.com/s2/favicons?domain=lis-skins.com&sz=64
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @connect      tradeit.gg
// @connect      www.tradeit.gg
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    if (window.top !== window.self) return;

    /*************************************************************************
     * Core state and constants
     *************************************************************************/

    const CONFIG = {
        steamFeeRate: 0.05,
        steamGameFeeRate: 0.10,
        steamTimeoutMs: 8000,
        siteTimeoutMs: 20000,
        steamCacheTtlMs: 5 * 60 * 1000,
        maxSteamCacheEntries: 1000,
        maxWorkLogEntries: 1000,
        moonPriceValidationDiscountPercent: 70,
        moonOfferCacheTtlMs: 60 * 1000,
        maxMoonOfferCacheEntries: 1000,
        intermediateSteamThreshold: 1000,
        intermediateSortEvery: 50,
        colors: {
            excellent: '#16a34a',
            positive: '#10b981',
            neutral: '#f59e0b',
            negative: '#dc2626',
            loading: '#2563eb',
            noOrders: '#64748b',
            notFound: '#7c3aed',
            panelBg: '#111827',
            panelFieldBg: '#1f2937',
            panelBorder: '#475569',
            panelAccent: '#38bdf8',
            panelSecondary: '#a78bfa',
            panelSuccess: '#22c55e',
            panelStatus: '#cbd5e1',
            text: '#fff'
        }
    };

    const STEAM_IMAGE_BASE_URL = 'https://steamcommunity-a.akamaihd.net/economy/image/';
    const CS2_ITEM_MODELS = new Map([
        ['AK-47'], ['AUG'], ['AWP'], ['FAMAS'], ['G3SG1'], ['Galil AR'], ['M4A1-S'], ['M4A4'],
        ['SCAR-20'], ['SG 553'], ['SSG 08'], ['CZ75-Auto'], ['Desert Eagle'], ['Dual Berettas'],
        ['Five-SeveN'], ['Glock-18'], ['P2000'], ['P250'], ['R8 Revolver'], ['Tec-9'], ['USP-S'],
        ['MAC-10'], ['MP5-SD'], ['MP7'], ['MP9'], ['P90'], ['PP-Bizon'], ['UMP-45'], ['MAG-7'],
        ['Nova'], ['Sawed-Off'], ['XM1014'], ['M249'], ['Negev'], ['Zeus x27'],
        ['Bayonet', '★ Bayonet'], ['Bowie Knife', '★ Bowie Knife'],
        ['Butterfly Knife', '★ Butterfly Knife'], ['Classic Knife', '★ Classic Knife'],
        ['Falchion Knife', '★ Falchion Knife'], ['Flip Knife', '★ Flip Knife'],
        ['Gut Knife', '★ Gut Knife'], ['Huntsman Knife', '★ Huntsman Knife'],
        ['Karambit', '★ Karambit'], ['Kukri Knife', '★ Kukri Knife'],
        ['M9 Bayonet', '★ M9 Bayonet'], ['Navaja Knife', '★ Navaja Knife'],
        ['Nomad Knife', '★ Nomad Knife'], ['Paracord Knife', '★ Paracord Knife'],
        ['Shadow Daggers', '★ Shadow Daggers'], ['Skeleton Knife', '★ Skeleton Knife'],
        ['Stiletto Knife', '★ Stiletto Knife'], ['Survival Knife', '★ Survival Knife'],
        ['Talon Knife', '★ Talon Knife'], ['Ursus Knife', '★ Ursus Knife'],
        ['Bloodhound Gloves', '★ Bloodhound Gloves'], ['Broken Fang Gloves', '★ Broken Fang Gloves'],
        ['Driver Gloves', '★ Driver Gloves'], ['Hand Wraps', '★ Hand Wraps'],
        ['Hydra Gloves', '★ Hydra Gloves'], ['Moto Gloves', '★ Moto Gloves'],
        ['Specialist Gloves', '★ Specialist Gloves'], ['Sport Gloves', '★ Sport Gloves']
    ].map(([source, canonical = source]) => [source.toLowerCase(), canonical]));
    const ATTRIBUTE = {
        processed: 'data-profit-helper-processed',
        filtered: 'data-profit-helper-filtered',
        profit: 'data-calculated-profit',
        profitPercent: 'data-calculated-profit-percent',
        result: 'data-profit-helper-result',
        queued: 'data-profit-helper-queued',
        marketHashName: 'data-market-hash-name',
        price: 'data-price',
        discount: 'data-discount'
    };

    const RESULT_STATUS = {
        success: 'success',
        error: 'error',
        noOrders: 'no-orders',
        notFound: 'not-found'
    };

    let panelInjected = false;
    let currentOperation = null;
    let operationId = 0;
    let steamQueue = [];
    let steamQueueRunning = false;
    let tooltipHideTimer = null;
    const steamCache = new Map();
    const workLogEntries = [];

    function createOperation() {
        currentOperation = {
            id: ++operationId,
            cancelled: false,
            cleanups: new Set(),
            startedAt: Date.now(),
            siteLoaded: 0,
            siteTotal: 0,
            steamDone: 0,
            steamTotal: 0,
            pendingSteamTotal: 0,
            pendingDetachedCards: [],
            lastPercent: 0,
            intermediateSteamPromise: null
        };
        return currentOperation;
    }

    function isOperationActive(operation) {
        return operation && currentOperation === operation && !operation.cancelled;
    }

    function finishOperation(operation, text = 'Готово!') {
        if (currentOperation !== operation) return;

        logWork('INFO', text, {
            operation: operation.id,
            duration: formatDuration(Date.now() - operation.startedAt),
            pages: `${operation.siteLoaded}/${operation.siteTotal}`,
            steam: `${operation.steamDone}/${operation.steamTotal}`
        });
        currentOperation = null;
        steamQueue = [];
        operation.pendingDetachedCards = [];
        steamQueueRunning = false;
        restoreAllParkedImages();
        steamCache.clear();
        setStartButtonLoading(false);
        setStatus(text);
        updateRetryErrorsButton();
    }

    function cancelOperation() {
        const operation = currentOperation;
        if (!operation) return;

        if (operation.siteTotal > operation.siteLoaded && !operation.stopLoadingRequested) {
            operation.stopLoadingRequested = true;
            logWork('WARN', 'Запрошена остановка загрузки страниц', { operation: operation.id });
            operation.cleanups.forEach(cleanup => {
                try { cleanup(); } catch (e) {}
            });
            setStatus('Останавливаю загрузку страниц...\nОбработаю уже загруженные карточки.');
            return;
        }

        operation.cancelled = true;
        logWork('WARN', 'Операция отменена пользователем', { operation: operation.id });
        operation.cleanups.forEach(cleanup => {
            try { cleanup(); } catch (e) {}
        });
        finishOperation(operation, 'Отменено.');
    }

    /*************************************************************************
     * Shared utilities
     *************************************************************************/

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function parseNumber(value) {
        const text = String(value || '').replace(/[^\d.,-]/g, '');
        if (!text) return NaN;

        const lastDot = text.lastIndexOf('.');
        const lastComma = text.lastIndexOf(',');
        if (lastDot !== -1 && lastComma !== -1) {
            const decimal = lastDot > lastComma ? '.' : ',';
            return parseFloat(text
                .replace(decimal === '.' ? /,/g : /\./g, '')
                .replace(decimal, '.'));
        }

        return parseFloat(text.replace(',', '.'));
    }

    function parsePrice(value) {
        const number = parseNumber(value);
        return Number.isFinite(number) && number > 0 ? number : NaN;
    }

    function parseDiscountPercent(value) {
        const matches = Array.from(String(value || '').matchAll(/[−-]?\s*([0-9]+(?:[.,][0-9]+)?)\s*%/g));
        const discounts = matches
            .map(match => Math.abs(parseFloat(match[1].replace(',', '.'))))
            .filter(Number.isFinite);

        return discounts.length ? Math.max(...discounts) : null;
    }

    function isValidPrice(value) {
        return Number.isFinite(value) && value > 0;
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    function encodeSteamMarketHashName(marketHashName) {
        return encodeURIComponent(marketHashName).replace(/[!'()*|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    }

    function buildSteamListingUrl(appId, marketHashName, searchParams = null) {
        const url = new URL(`https://steamcommunity.com/market/listings/${appId}/${encodeSteamMarketHashName(marketHashName)}`);
        Object.entries(searchParams || {}).forEach(([key, value]) => {
            if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
        });
        return url.toString();
    }

    function formatCurrency(value) {
        return `${Number(value).toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })} ₽`;
    }

    function getDeepValue(object, keys) {
        if (!object || typeof object !== 'object') return null;

        for (const key of keys) {
            if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
        }

        for (const value of Object.values(object)) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const nested = getDeepValue(value, keys);
                if (nested !== null && nested !== undefined && nested !== '') return nested;
            }
        }

        return null;
    }

    function getDirectText(element) {
        return normalizeText(Array.from(element?.childNodes || [])
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent)
            .join(' '));
    }

    function firstText(root, selectors) {
        for (const selector of selectors) {
            const element = root?.querySelector?.(selector);
            const value = normalizeText(element?.getAttribute?.(ATTRIBUTE.discount)
                || element?.getAttribute?.('title')
                || element?.getAttribute?.('aria-label')
                || element?.textContent
                || '');
            if (value) return value;
        }
        return '';
    }

    function uniqueElements(elements) {
        return Array.from(new Set(elements.filter(Boolean)));
    }

    function isElementVisible(element) {
        for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
            const view = node.ownerDocument?.defaultView || window;
            const style = view.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
    }

    async function fetchJson(url, { signal, credentials = 'include' } = {}) {
        const response = await fetch(url, {
            signal,
            credentials,
            headers: { Accept: 'application/json, text/plain, */*' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    async function fetchDocument(url, { signal } = {}) {
        const response = await fetch(url, { signal, credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new DOMParser().parseFromString(await response.text(), 'text/html');
    }

    function makeHtmlLightweight(html) {
        const withoutHeavyElements = String(html || '')
            .replace(/<(script|style|iframe|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
            .replace(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi, '');
        const parkedAttributes = {
            src: 'data-profit-original-src',
            srcset: 'data-profit-original-srcset',
            'data-src': 'data-profit-original-data-src',
            'data-lazy-src': 'data-profit-original-data-lazy-src'
        };

        return withoutHeavyElements.replace(/<img\b[^>]*>/gi, tag => tag.replace(
            /\s(src|srcset|data-src|data-lazy-src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
            (attribute, name, value) => ` ${parkedAttributes[name.toLowerCase()]}=${value}`
        ));
    }

    async function fetchInertHtmlFragment(url, { signal } = {}) {
        const response = await fetch(url, {
            signal,
            credentials: 'include',
            headers: { Accept: 'text/html,application/xhtml+xml' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new DOMParser().parseFromString(makeHtmlLightweight(await response.text()), 'text/html');
    }

    function gmRequestJson(url, { timeout = CONFIG.steamTimeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest недоступен'));
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout,
                headers: { Accept: 'application/json, text/plain, */*' },
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('Ответ не JSON'));
                    }
                },
                onerror: () => reject(new Error('Ошибка запроса')),
                ontimeout: () => reject(new Error('Таймаут запроса'))
            });
        });
    }

    function withTimeout(operation, timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const cleanup = () => {
            clearTimeout(timeoutId);
            controller.abort();
        };
        operation.cleanups.add(cleanup);
        return { signal: controller.signal, cleanup };
    }

    function waitForOperationDelay(operation, delayMs) {
        if (!isOperationActive(operation) || delayMs <= 0) return Promise.resolve();

        return new Promise(resolve => {
            let timerId = null;
            const finish = () => {
                if (timerId !== null) clearTimeout(timerId);
                operation.cleanups.delete(finish);
                resolve();
            };
            timerId = setTimeout(finish, delayMs);
            operation.cleanups.add(finish);
        });
    }

    /*************************************************************************
     * Steam primary API
     *************************************************************************/

    function pruneSteamCache() {
        const now = Date.now();
        for (const [key, value] of steamCache.entries()) {
            if (!value.fetchedAt || now - value.fetchedAt > CONFIG.steamCacheTtlMs) steamCache.delete(key);
        }
        while (steamCache.size > CONFIG.maxSteamCacheEntries) steamCache.delete(steamCache.keys().next().value);
    }

    function parseOrderBookRows(orderBook) {
        const compactOrders = orderBook?.data?.rgCompactBuyOrders || orderBook?.rgCompactBuyOrders;
        if (!Array.isArray(compactOrders)) return [];

        const rows = [];
        for (let index = 0; index + 1 < compactOrders.length && rows.length < 20; index += 2) {
            const salePrice = Number(compactOrders[index]) / 100;
            const ordersCount = String(compactOrders[index + 1] ?? '').replace(/\s| /g, '');
            if (!isValidPrice(salePrice) || !ordersCount) continue;

            rows.push({ salePrice, ordersCount });
        }
        return rows;
    }

    async function fetchSteamBestBuyOrder(appId, marketHashName, { forceRefresh = false } = {}) {
        pruneSteamCache();
        const cacheKey = `${appId}:${marketHashName}`;
        if (forceRefresh) steamCache.delete(cacheKey);
        const cached = steamCache.get(cacheKey);
        if (cached) return cached;

        const url = new URL('https://steamcommunity.com/market/orderbook');
        url.searchParams.set('q', 'Load');
        url.searchParams.set('qp', JSON.stringify([appId, marketHashName]));

        const data = await gmRequestJson(url.toString());
        if (data?.success !== undefined && data.success !== true && data.success !== 1) {
            const result = {
                status: 'not-found',
                steamPrice: NaN,
                rows: [],
                fetchedAt: Date.now()
            };
            steamCache.set(cacheKey, result);
            return result;
        }

        const rows = parseOrderBookRows(data);
        const result = {
            status: rows.length ? 'price' : 'no-orders',
            steamPrice: rows[0]?.salePrice || NaN,
            rows,
            fetchedAt: Date.now()
        };
        steamCache.set(cacheKey, result);
        return result;
    }

    function calculateSteamSale(steamPrice, sitePrice) {
        const saleCents = Math.round(steamPrice * 100);
        const buyCents = Math.round(sitePrice * 100);
        const steamFee = Math.floor(Math.max(saleCents * CONFIG.steamFeeRate, 1));
        const gameFee = Math.floor(Math.max(saleCents * CONFIG.steamGameFeeRate, 1));
        const netSale = saleCents - steamFee - gameFee;

        return {
            netProfit: (netSale - buyCents) / 100,
            netSale: netSale / 100,
            steamFee: steamFee / 100,
            gameFee: gameFee / 100
        };
    }

    /*************************************************************************
     * UI
     *************************************************************************/

    function formatWorkLogDetails(details) {
        if (details === null || details === undefined || details === '') return '';
        if (typeof details === 'string') return details;

        try {
            return Object.entries(details)
                .filter(([, value]) => value !== null && value !== undefined && value !== '')
                .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
                .join('; ');
        } catch (_) {
            return String(details);
        }
    }

    function renderWorkLog() {
        const output = document.getElementById('profit-helper-work-log');
        const panel = document.getElementById('profit-helper-panel');
        if (!output || panel?.dataset.logOpen !== 'true') return;

        output.value = workLogEntries.join('\n');
        output.scrollTop = output.scrollHeight;
    }

    function logWork(level, message, details = null) {
        const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
        const detailsText = formatWorkLogDetails(details);
        workLogEntries.push(`[${time}] [${level}] ${message}${detailsText ? ` | ${detailsText}` : ''}`);
        if (workLogEntries.length > CONFIG.maxWorkLogEntries) {
            workLogEntries.splice(0, workLogEntries.length - CONFIG.maxWorkLogEntries);
        }
        renderWorkLog();
    }

    function clearWorkLog() {
        workLogEntries.length = 0;
        logWork('INFO', 'Лог очищен');
    }

    function setStatus(text) {
        const status = document.getElementById('combine-status');
        if (status) status.innerText = text || '';
    }

    function showToast(message, kind = 'success') {
        if (kind === 'error') logWork('ERROR', message);
        let container = document.getElementById('profit-helper-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'profit-helper-toast-container';
            container.style = 'position: fixed; top: 20px; right: 20px; z-index: 99999999; display: flex; flex-direction: column; gap: 10px;';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.style = `
            background: ${kind === 'error' ? CONFIG.colors.negative : CONFIG.colors.excellent};
            color: ${CONFIG.colors.text};
            padding: 12px 18px;
            border-radius: 6px;
            font-family: sans-serif;
            font-size: 13px;
            font-weight: bold;
            box-shadow: 0 4px 12px rgba(0,0,0,.45);
            min-width: 250px;
            transition: opacity .4s ease;
        `;
        toast.innerText = `Profit-Calculator: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, 8000);
    }

    function setStartButtonLoading(isLoading) {
        const button = document.getElementById('start-combine');
        if (!button) return;

        button.disabled = false;
        button.innerHTML = isLoading
            ? '<span id="profit-helper-button-bar" class="profit-button-progress-bar"></span><span class="profit-button-content"><span class="profit-helper-spinner"></span><span id="profit-helper-button-progress">Остановить 0%</span></span>'
            : 'Найти выгодные';
        button.style.background = isLoading ? CONFIG.colors.negative : CONFIG.colors.excellent;
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        if (minutes <= 0) return `${seconds} сек`;
        return `${minutes} мин ${seconds} сек`;
    }

    function getProgressSnapshot(operation) {
        const completed = operation.siteLoaded + operation.steamDone;
        const total = Math.max(operation.siteTotal + operation.steamTotal + operation.pendingSteamTotal, completed);
        const percent = total > 0 ? Math.min(Math.floor((completed / total) * 100), 99) : 0;

        const elapsedMs = Date.now() - operation.startedAt;
        const remaining = Math.max(total - completed, 0);
        const etaText = completed > 0 && remaining > 0
            ? `примерно ${formatDuration((elapsedMs / completed) * remaining)}`
            : '';

        return { completed, total, percent, etaText };
    }

    function updateButtonProgress(operation) {
        const buttonProgress = document.getElementById('profit-helper-button-progress');
        const buttonBar = document.getElementById('profit-helper-button-bar');
        if (!buttonProgress) return;

        const percent = getProgressSnapshot(operation).percent;
        buttonProgress.innerText = `Остановить ${percent}%`;
        if (buttonBar) buttonBar.style.width = `${percent}%`;
    }

    function updateStatus(operation) {
        const parts = [];
        if (operation.siteTotal > 0) parts.push(`Сайт ${operation.siteLoaded}/${operation.siteTotal}`);
        if (operation.steamTotal > 0) parts.push(`Steam ${operation.steamDone}/${operation.steamTotal}`);
        if (operation.pendingToIntermediateText) parts.push(operation.pendingToIntermediateText);
        const { etaText } = getProgressSnapshot(operation);
        if (etaText) parts.push(etaText);
        updateButtonProgress(operation);
        setStatus(parts.length ? parts.join('\n') : 'Работаю...');
    }

    function readNumberInput(id, defaultValue) {
        const input = document.getElementById(id);
        const value = parseFloat(input?.value);
        return Number.isFinite(value) ? value : defaultValue;
    }

    function changeBoundedInput(input, delta) {
        if (!input) return;

        const min = input.min === '' ? -Infinity : parseFloat(input.min);
        const max = input.max === '' ? Infinity : parseFloat(input.max);
        const step = input.step === '' || input.step === 'any' ? 1 : parseFloat(input.step);
        const amount = Number.isFinite(step) && step > 0 ? step * delta : delta;
        const current = parseFloat(input.value) || 0;
        input.value = String(Math.min(max, Math.max(min, current + amount)));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function bindNumberControls(panel) {
        panel.querySelectorAll('.profit-stepper').forEach(button => {
            button.addEventListener('click', () => {
                const input = document.getElementById(button.dataset.target);
                const delta = parseFloat(button.dataset.delta || '0');
                changeBoundedInput(input, delta);
            });
        });

        panel.querySelectorAll('input[type="number"], input[type="range"]').forEach(input => {
            input.addEventListener('wheel', event => {
                event.preventDefault();
                changeBoundedInput(input, event.deltaY < 0 ? 1 : -1);
            }, { passive: false });
        });
    }

    function settingRow(label, id, value, min, max, color, tooltip) {
        return `
            <div class="profit-setting-row">
                <label for="${id}">${label}</label>
                <div class="profit-number-control">
                    <input id="${id}" type="number" min="${min}" max="${max}" value="${value}">
                    <div class="profit-stepper-buttons">
                        <button type="button" class="profit-stepper" data-target="${id}" data-delta="1">▲</button>
                        <button type="button" class="profit-stepper" data-target="${id}" data-delta="-1">▼</button>
                    </div>
                </div>
                <span class="profit-help" title="${escapeHtml(tooltip)}">?</span>
            </div>
            <input id="${id}-range" type="range" min="${min}" max="${max}" value="${value}" style="--range-color:${color}">
        `;
    }

    function getPanelPositionStorageKey() {
        return `profit_helper_panel_position_${window.location.hostname}`;
    }

    function getLogWidthStorageKey() {
        return `profit_helper_log_width_${window.location.hostname}`;
    }

    function clampLogWidth(value) {
        const maxWidth = Math.max(300, window.innerWidth - 236);
        return Math.min(maxWidth, Math.max(300, Number.isFinite(value) ? value : 532));
    }

    function setLogWidth(panel, width, save = false) {
        const normalizedWidth = Math.round(clampLogWidth(width));
        panel.style.setProperty('--profit-log-width', `${normalizedWidth}px`);
        if (save) localStorage.setItem(getLogWidthStorageKey(), String(normalizedWidth));
        return normalizedWidth;
    }

    function restoreLogWidth(panel) {
        setLogWidth(panel, parseFloat(localStorage.getItem(getLogWidthStorageKey())));
    }

    function clampPanelPosition(panel, left, top) {
        const rect = panel.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));
        return {
            left: Math.min(maxLeft, Math.max(0, Number.isFinite(left) ? left : rect.left)),
            top: Math.min(maxTop, Math.max(0, Number.isFinite(top) ? top : rect.top))
        };
    }

    function setPanelPosition(panel, left, top, save = false) {
        const position = clampPanelPosition(panel, left, top);
        panel.style.left = `${Math.round(position.left)}px`;
        panel.style.top = `${Math.round(position.top)}px`;
        panel.style.right = 'auto';
        if (save) localStorage.setItem(getPanelPositionStorageKey(), JSON.stringify(position));
    }

    function restorePanelPosition(panel) {
        try {
            const saved = JSON.parse(localStorage.getItem(getPanelPositionStorageKey()) || 'null');
            if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
                setPanelPosition(panel, saved.left, saved.top);
                return;
            }
        } catch (_) {}
        setPanelPosition(panel, 8, 140);
    }

    function bindPanelDragging(panel, onTitleClick) {
        const handle = panel.querySelector('.profit-title');
        if (!handle) return;

        let drag = null;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const rect = panel.getBoundingClientRect();
            drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                top: rect.top,
                moved: false
            };
            handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('pointermove', event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - drag.startX;
            const deltaY = event.clientY - drag.startY;
            if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;

            drag.moved = true;
            panel.dataset.dragging = 'true';
            event.preventDefault();
            setPanelPosition(panel, drag.left + deltaX, drag.top + deltaY);
        });
        const finishDrag = event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const wasMoved = drag.moved;
            drag = null;
            panel.removeAttribute('data-dragging');
            if (!wasMoved) return;

            const rect = panel.getBoundingClientRect();
            setPanelPosition(panel, rect.left, rect.top, true);
            panel.dataset.justDragged = 'true';
            setTimeout(() => panel.removeAttribute('data-just-dragged'), 0);
        };
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('click', event => {
            if (panel.dataset.justDragged === 'true') {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            onTitleClick();
        });
    }

    function bindLogResizing(panel) {
        const handle = panel.querySelector('#profit-helper-log-resizer');
        const logSection = panel.querySelector('#profit-helper-log-section');
        if (!handle || !logSection) return;

        let resize = null;
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || panel.dataset.logOpen !== 'true') return;
            resize = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startWidth: logSection.getBoundingClientRect().width,
                width: logSection.getBoundingClientRect().width
            };
            panel.dataset.logResizing = 'true';
            handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener('pointermove', event => {
            if (!resize || resize.pointerId !== event.pointerId) return;
            resize.width = setLogWidth(panel, resize.startWidth + event.clientX - resize.startX);
            const rect = panel.getBoundingClientRect();
            setPanelPosition(panel, rect.left, rect.top);
            event.preventDefault();
        });
        const finishResize = event => {
            if (!resize || resize.pointerId !== event.pointerId) return;
            setLogWidth(panel, resize.width, true);
            resize = null;
            panel.removeAttribute('data-log-resizing');
        };
        handle.addEventListener('pointerup', finishResize);
        handle.addEventListener('pointercancel', finishResize);
    }

    function injectPanel() {
        const existingPanel = document.getElementById('profit-helper-panel');
        if (existingPanel?.isConnected) return;
        panelInjected = false;
        if (!document.body || !getCurrentAdapter()) return;

        panelInjected = true;
        let style = document.getElementById('profit-helper-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'profit-helper-style';
            style.textContent = `
            @keyframes profit-spin { to { transform: rotate(360deg); } }
            .profit-helper-spinner {
                display: inline-block; width: 12px; height: 12px; margin-right: 6px;
                border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
                border-radius: 50%; animation: profit-spin 1s linear infinite;
            }
            #profit-helper-panel, #profit-helper-panel * { box-sizing: border-box !important; }
            #profit-helper-panel {
                position: fixed; top: 140px; left: 8px; z-index: 9999999;
                width: 215px; padding: 12px; border-radius: 8px;
                max-width: calc(100vw - 8px); max-height: calc(100vh - 8px); overflow: auto;
                background: ${CONFIG.colors.panelBg}; color: ${CONFIG.colors.text};
                border: 1px solid ${CONFIG.colors.panelBorder};
                box-shadow: 0 4px 15px rgba(0,0,0,.8);
                font: 13px Arial, "Helvetica Neue", sans-serif;
            }
            #profit-helper-panel[data-log-open="true"]:not([data-collapsed="true"]) {
                width: min(calc(var(--profit-log-width, 532px) + 228px), calc(100vw - 8px));
            }
            #profit-helper-panel[data-collapsed="true"] {
                width: 28px; min-width: 28px; padding: 8px 3px;
                border-radius: 0 8px 8px 0; cursor: pointer;
            }
            .profit-title {
                color: ${CONFIG.colors.panelAccent}; font-weight: bold; text-align: center; margin-bottom: 14px;
                cursor: grab; user-select: none; touch-action: none;
            }
            #profit-helper-panel[data-dragging="true"] .profit-title { cursor: grabbing; }
            #profit-helper-panel[data-collapsed="true"] .profit-title {
                writing-mode: vertical-rl; transform: rotate(180deg); margin: 0 auto;
                white-space: nowrap; line-height: 1;
            }
            #profit-helper-panel[data-collapsed="true"] .profit-panel-content {
                display: none !important;
            }
            .profit-setting-row {
                display: grid; grid-template-columns: minmax(0,1fr) auto auto;
                align-items: center; gap: 5px; margin-bottom: 5px;
            }
            .profit-setting-row label { line-height: 1.2; }
            .profit-number-control { display: flex; gap: 3px; }
            .profit-number-control input {
                width: 55px; height: 30px; border-radius: 4px;
                border: 1px solid ${CONFIG.colors.panelBorder};
                background: ${CONFIG.colors.panelFieldBg}; color: ${CONFIG.colors.text};
                text-align: center; font-weight: bold;
                appearance: textfield; -moz-appearance: textfield;
            }
            .profit-number-control input::-webkit-outer-spin-button,
            .profit-number-control input::-webkit-inner-spin-button {
                -webkit-appearance: none; margin: 0;
            }
            .profit-stepper-buttons { display: flex; flex-direction: column; gap: 2px; }
            .profit-stepper {
                width: 18px !important; height: 14px !important; min-width: 18px !important; min-height: 14px !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                padding: 0 !important; margin: 0 !important; border-radius: 3px !important;
                border: 1px solid ${CONFIG.colors.panelBorder} !important;
                background: ${CONFIG.colors.panelFieldBg} !important; color: ${CONFIG.colors.text} !important;
                font-size: 9px !important; line-height: 1 !important; cursor: pointer !important;
                text-align: center !important; font-family: Arial, "Helvetica Neue", sans-serif !important;
            }
            .profit-help {
                width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;
                border-radius: 50%; background: ${CONFIG.colors.panelBorder}; color: ${CONFIG.colors.text};
                font-size: 11px; cursor: help;
            }
            #profit-helper-panel input[type="range"] {
                width: 100% !important; height: 18px !important; margin: 0 0 15px !important;
                padding: 0 !important; background: transparent !important; accent-color: var(--range-color) !important;
                appearance: auto !important; -webkit-appearance: none !important;
            }
            #profit-helper-panel input[type="range"]::-webkit-slider-runnable-track {
                height: 4px !important; border-radius: 999px !important; background: var(--range-color) !important;
                border: 0 !important; box-shadow: none !important;
            }
            #profit-helper-panel input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none !important; width: 16px !important; height: 16px !important;
                margin-top: -6px !important; border-radius: 50% !important; background: var(--range-color) !important;
                border: 2px solid #fff !important; box-shadow: 0 1px 4px rgba(0,0,0,.4) !important;
            }
            #profit-helper-panel input[type="range"]::-moz-range-track {
                height: 4px !important; border-radius: 999px !important; background: var(--range-color) !important;
                border: 0 !important; box-shadow: none !important;
            }
            #profit-helper-panel input[type="range"]::-moz-range-thumb {
                width: 16px !important; height: 16px !important; border-radius: 50% !important;
                background: var(--range-color) !important; border: 2px solid #fff !important;
                box-shadow: 0 1px 4px rgba(0,0,0,.4) !important;
            }
            #start-combine {
                position: relative !important; overflow: hidden !important;
                display: flex !important; align-items: center !important; justify-content: center !important;
                width: 100% !important; min-height: 33px !important; border: 0 !important; border-radius: 4px !important; cursor: pointer !important;
                padding: 9px !important; color: #fff !important; background: ${CONFIG.colors.excellent};
                font-weight: bold !important; text-align: center !important; line-height: 1.2 !important;
            }
            #retry-errors-combine {
                display: none !important; align-items: center !important; justify-content: center !important;
                width: 100% !important; min-height: 33px !important; margin-top: 8px !important;
                border: 0 !important; border-radius: 4px !important; cursor: pointer !important;
                padding: 9px !important; color: #fff !important; background: ${CONFIG.colors.panelSecondary};
                font-weight: bold !important; text-align: center !important; line-height: 1.2 !important;
            }
            #retry-errors-combine[data-visible="true"] {
                display: flex !important;
            }
            #toggle-work-log, #clear-work-log {
                border: 1px solid ${CONFIG.colors.panelBorder} !important; border-radius: 4px !important;
                color: ${CONFIG.colors.text} !important; background: ${CONFIG.colors.panelFieldBg} !important;
                font-weight: bold !important; cursor: pointer !important;
            }
            #toggle-work-log {
                width: 100% !important; min-height: 33px !important; margin-top: 8px !important; padding: 8px !important;
            }
            #profit-helper-log-section { display: none; min-width: 0; margin: 0; }
            #profit-helper-panel[data-log-open="true"] #profit-helper-log-section { display: block; }
            #profit-helper-panel[data-log-open="true"] .profit-panel-content {
                display: grid; grid-template-columns: 190px minmax(300px, 1fr); gap: 14px; align-items: stretch;
            }
            .profit-controls-column { min-width: 0; }
            #profit-helper-log-resizer {
                display: none; position: absolute; top: 0; right: 0; bottom: 0; z-index: 5;
                width: 8px; cursor: col-resize; touch-action: none;
                background: transparent;
                transition: background .15s ease;
            }
            #profit-helper-panel[data-log-open="true"] #profit-helper-log-resizer { display: block; }
            #profit-helper-log-resizer:hover,
            #profit-helper-panel[data-log-resizing="true"] #profit-helper-log-resizer {
                background: color-mix(in srgb, ${CONFIG.colors.panelAccent} 55%, transparent);
            }
            .profit-helper-log-header {
                display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;
                color: ${CONFIG.colors.panelStatus}; font-weight: bold;
            }
            #clear-work-log { padding: 5px 9px !important; font-size: 11px !important; }
            #profit-helper-work-log {
                display: block; width: 100%; height: 520px; min-height: 240px; resize: vertical;
                padding: 9px; border: 1px solid ${CONFIG.colors.panelBorder}; border-radius: 4px;
                background: #0b1220; color: #dbeafe; font: 11px/1.45 monospace;
                white-space: pre; overflow: auto;
            }
            @media (max-width: 580px) {
                #profit-helper-panel[data-log-open="true"] .profit-panel-content {
                    grid-template-columns: minmax(0, 1fr);
                }
                #profit-helper-log-resizer { display: none !important; }
                #profit-helper-work-log { height: 280px; }
            }
            .profit-button-progress-bar {
                position: absolute; top: 0; bottom: 0; left: 0; width: 0%;
                background: ${CONFIG.colors.excellent}; transition: width .25s ease; pointer-events: none;
            }
            .profit-button-content {
                position: relative; z-index: 1; display: inline-flex !important;
                align-items: center !important; justify-content: center !important; text-align: center !important;
                width: 100% !important;
            }
            #combine-status {
                margin-top: 8px; color: ${CONFIG.colors.panelStatus}; font-size: 11px; text-align: center; white-space: pre-line;
            }
            .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                position: absolute; top: 32px; left: 10px; right: 10px; z-index: 30;
                display: flex !important; align-items: stretch !important; padding: 0 !important;
                color: #fff !important; font: bold 11px Arial, sans-serif;
                border-radius: 4px; text-decoration: none !important; line-height: 1.25;
                white-space: normal; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,.3);
            }
            .profit-helper-badge-link {
                flex: 1 1 auto; min-width: 0; display: flex; align-items: center;
                padding: 3px 6px; color: #fff !important; text-decoration: none !important;
                overflow-wrap: anywhere;
            }
            .profit-helper-badge-refresh {
                flex: 0 0 24px !important; width: 24px !important; min-width: 24px !important;
                min-height: 22px !important; margin: 0 !important; padding: 0 !important;
                display: inline-flex !important; align-items: center !important; justify-content: center !important;
                border: 0 !important; border-left: 1px solid rgba(255,255,255,.3) !important;
                border-radius: 0 !important; background: rgba(0,0,0,.16) !important;
                color: #fff !important; cursor: pointer !important;
            }
            .profit-helper-badge-refresh:hover:not(:disabled) { background: rgba(255,255,255,.18) !important; }
            .profit-helper-badge-refresh:disabled { cursor: wait !important; opacity: .7 !important; }
            .profit-helper-badge-refresh svg {
                width: 13px; height: 13px; display: block; fill: none; stroke: currentColor;
                stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
            }
            .steam-highest-buy-order-link[data-refreshing="true"] .profit-helper-badge-refresh svg {
                animation: profit-spin 1s linear infinite;
            }
            ${getAdapterStyles()}
            .profit-helper-tooltip {
                position: fixed; z-index: 100000000; min-width: 520px; max-width: min(760px, calc(100vw - 20px));
                padding: 10px; border-radius: 6px; background: #0f172a; color: #e5e7eb;
                border: 1px solid ${CONFIG.colors.panelBorder}; box-shadow: 0 6px 18px rgba(0,0,0,.55);
                font: 12px Arial, "Helvetica Neue", sans-serif; pointer-events: auto;
            }
            .profit-helper-tooltip table { width: 100%; border-collapse: collapse; }
            .profit-helper-tooltip th, .profit-helper-tooltip td {
                padding: 5px 7px; border-bottom: 1px solid rgba(148,163,184,.25);
                text-align: right; white-space: nowrap; vertical-align: middle;
            }
            .profit-helper-tooltip tr:last-child td { border-bottom: 0; }
            .profit-helper-tooltip-profit { font-weight: bold; color: #fff; border-radius: 3px; }
        `;
            document.head.appendChild(style);
        }

        const saved = {
            discount: localStorage.getItem('profit_helper_discount') || '0',
            pages: localStorage.getItem('profit_helper_pages') || '1',
            siteWorkers: localStorage.getItem('profit_helper_site_workers') || '4',
            pageDelay: localStorage.getItem('profit_helper_page_delay')
                || localStorage.getItem('profit_helper_skinport_delay')
                || '1',
            steamWorkers: localStorage.getItem('profit_helper_steam_workers') || '3',
            minProfit: localStorage.getItem('profit_helper_min_profit') || '-100',
            tooltipRows: localStorage.getItem('profit_helper_tooltip_rows') || '3'
        };

        const panel = document.createElement('div');
        panel.id = 'profit-helper-panel';
        panel.dataset.collapsed = localStorage.getItem('profit_helper_panel_collapsed') === '1' ? 'true' : 'false';
        panel.dataset.logOpen = 'false';
        panel.innerHTML = `
            <div class="profit-title" title="Перетащить панель; нажать, чтобы свернуть">Profit-Calculator</div>
            <div class="profit-panel-content">
                <div class="profit-controls-column">
                    ${settingRow('Скидка, от %:', 'discount-input', saved.discount, 0, 100, CONFIG.colors.panelAccent, 'Минимальная скидка сайта.')}
                    ${settingRow('Страниц сайта:', 'pages-input', saved.pages, 0, 999, CONFIG.colors.panelSecondary, 'Сколько дополнительных страниц сайта загрузить.')}
                    ${settingRow('Потоков сайта:', 'site-workers-input', saved.siteWorkers, 1, 33, CONFIG.colors.neutral, 'Сколько страниц сайта грузить одновременно.')}
                    ${settingRow('Пауза страниц, сек:', 'page-delay-input', saved.pageDelay, 0, 10, CONFIG.colors.neutral, 'Пауза между запросами страниц сайта в одном потоке.')}
                    ${settingRow('Запросов Steam:', 'steam-workers-input', saved.steamWorkers, 1, 99, CONFIG.colors.panelSuccess, 'Сколько запросов Steam делать одновременно.')}
                    ${settingRow('Мин. выгода, от %:', 'min-profit-input', saved.minProfit, -100, 30, CONFIG.colors.negative, 'Скрывать карточки ниже этой выгоды после расчета.')}
                    ${settingRow('Строк в таблице:', 'tooltip-rows-input', saved.tooltipRows, 1, 20, CONFIG.colors.panelAccent, 'Сколько строк заявок показывать в таблице при наведении.')}
                    <button id="start-combine" type="button">Найти выгодные</button>
                    <button id="retry-errors-combine" type="button">Повторить обработку ошибочных</button>
                    <button id="toggle-work-log" type="button">Лог работы</button>
                    <div id="combine-status"></div>
                </div>
                <div id="profit-helper-log-resizer" title="Изменить ширину лога" aria-hidden="true"></div>
                <div id="profit-helper-log-section">
                    <div class="profit-helper-log-header">
                        <span>Последние ${CONFIG.maxWorkLogEntries} записей</span>
                        <button id="clear-work-log" type="button">Очистить</button>
                    </div>
                    <textarea id="profit-helper-work-log" readonly spellcheck="false" aria-label="Лог работы"></textarea>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        restoreLogWidth(panel);
        restorePanelPosition(panel);
        renderWorkLog();

        const adapter = getCurrentAdapter();
        const hiddenPaginationControls = adapter?.supportsPagination === false
            ? ['pages-input', 'site-workers-input', 'page-delay-input']
            : [];
        hiddenPaginationControls.forEach(id => {
                document.getElementById(id)?.closest('.profit-setting-row')?.style.setProperty('display', 'none');
                document.getElementById(`${id}-range`)?.style.setProperty('display', 'none', 'important');
        });

        const toggleCollapsed = () => {
            const collapsed = panel.dataset.collapsed !== 'true';
            panel.dataset.collapsed = collapsed ? 'true' : 'false';
            localStorage.setItem('profit_helper_panel_collapsed', collapsed ? '1' : '0');
            requestAnimationFrame(() => restorePanelPosition(panel));
        };
        bindPanelDragging(panel, toggleCollapsed);
        bindLogResizing(panel);
        panel.addEventListener('click', event => {
            if (panel.dataset.collapsed !== 'true'
                || panel.dataset.justDragged === 'true'
                || event.target.closest('.profit-title')) return;
            toggleCollapsed();
        });

        bindNumberControls(panel);
        [
            ['discount-input', 'profit_helper_discount'],
            ['pages-input', 'profit_helper_pages'],
            ['site-workers-input', 'profit_helper_site_workers'],
            ['page-delay-input', 'profit_helper_page_delay'],
            ['steam-workers-input', 'profit_helper_steam_workers'],
            ['min-profit-input', 'profit_helper_min_profit'],
            ['tooltip-rows-input', 'profit_helper_tooltip_rows']
        ].forEach(([id, storageKey]) => {
            const input = document.getElementById(id);
            const range = document.getElementById(`${id}-range`);
            const sync = source => {
                const value = source.value;
                input.value = value;
                range.value = value;
                localStorage.setItem(storageKey, value);
            };
            input.addEventListener('input', () => sync(input));
            range.addEventListener('input', () => sync(range));
        });

        document.getElementById('start-combine')?.addEventListener('click', runSearch);
        document.getElementById('retry-errors-combine')?.addEventListener('click', runRetryErroredCards);
        document.getElementById('toggle-work-log')?.addEventListener('click', () => {
            const isOpen = panel.dataset.logOpen !== 'true';
            panel.dataset.logOpen = isOpen ? 'true' : 'false';
            document.getElementById('toggle-work-log').innerText = isOpen ? 'Скрыть лог' : 'Лог работы';
            requestAnimationFrame(() => {
                restorePanelPosition(panel);
                if (isOpen) renderWorkLog();
                else document.getElementById('profit-helper-work-log').value = '';
            });
        });
        document.getElementById('clear-work-log')?.addEventListener('click', clearWorkLog);
        updateRetryErrorsButton();
    }

    /*************************************************************************
     * Site adapter registry
     *************************************************************************/

    function getCurrentAdapter() {
        return ADAPTERS.find(adapter => adapter.matches());
    }

    function getCardAdapter(card, preferredAdapter = getCurrentAdapter()) {
        if (preferredAdapter?.ownsCard(card)) return preferredAdapter;

        return ADAPTERS.find(adapter => adapter !== preferredAdapter && adapter.ownsCard(card)) || preferredAdapter;
    }

    function getAdapterStyles() {
        return ADAPTERS.map(adapter => adapter.getStyles?.() || '').filter(Boolean).join('\n');
    }

    function resetCards(adapter) {
        document.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
        adapter.getCards().forEach(card => {
            card.style.display = '';
            card.removeAttribute(ATTRIBUTE.processed);
            card.removeAttribute(ATTRIBUTE.filtered);
            card.removeAttribute(ATTRIBUTE.profit);
            card.removeAttribute(ATTRIBUTE.profitPercent);
            card.removeAttribute(ATTRIBUTE.result);
            card.removeAttribute(ATTRIBUTE.queued);
        });
        adapter.afterReset?.();
    }

    /*************************************************************************
     * Adapter: LIS
     *************************************************************************/

    const LisAdapter = {
        id: 'lis',
        gridCache: new WeakMap(),
        cardsCache: new WeakMap(),
        linkCountCache: new WeakMap(),
        nameCache: new WeakMap(),
        nameElementCache: new WeakMap(),
        priceCache: new WeakMap(),
        discountCache: new WeakMap(),
        csTextValuesCache: new WeakMap(),
        csExteriorCache: new WeakMap(),
        cardTemplate: null,
        cardAttribute: 'data-profit-helper-lis-card',
        gridAttribute: 'data-profit-helper-lis-grid',
        matches: () => window.location.hostname === 'lis-skins.com',
        getAppId: () => detectAppId(252490),
        cardSelectors: [
            'a[href*="/market/"][href*="/rust/"]',
            'a[href*="/market/"]'
        ],
        isIgnoredContainer(element) {
            return Boolean(element?.closest?.('#profit-helper-panel, header, nav, footer'));
        },
        getScope(root = document) {
            return root.querySelector?.('main') || root.body || (root instanceof Element ? root : null);
        },
        getItemLinks(root) {
            if (!root?.querySelectorAll) return [];
            const links = [];
            if (root.matches?.(this.cardSelectors.join(','))) links.push(root);
            links.push(...root.querySelectorAll(this.cardSelectors.join(',')));
            return uniqueElements(links).filter(link => this.isItemLink(link));
        },
        isItemLink(link) {
            if (!(link instanceof Element) || this.isIgnoredContainer(link)) return false;
            if (!link.matches('a[href*="/market/"]')) return false;
            if (link.querySelectorAll('a[href*="/market/"]').length > 1) return false;
            if (!link.querySelector('img')) return false;

            return isValidPrice(this.getPrice(link)) && Boolean(this.getName(link));
        },
        getCachedGrid(root) {
            const cached = this.gridCache.get(root);
            if (!cached?.isConnected) return null;
            if (this.isIgnoredContainer(cached)) return null;
            return cached;
        },
        setCachedGrid(root, grid) {
            if (grid) this.gridCache.set(root, grid);
            return grid;
        },
        getCachedCards(container) {
            const cached = this.cardsCache.get(container);
            if (!cached || cached.version !== container.childElementCount) return null;
            if (!cached.cards.every(card => card.isConnected)) return null;
            return cached.cards;
        },
        setCachedCards(container, cards) {
            this.cardsCache.set(container, {
                version: container.childElementCount,
                cards
            });
            return cards;
        },
        getItemLinksCount(container) {
            const cached = this.linkCountCache.get(container);
            if (cached?.version === container.childElementCount) return cached.count;

            const count = container.matches?.(this.cardSelectors.join(',')) ? 1 : container.querySelectorAll?.(this.cardSelectors.join(',')).length || 0;
            this.linkCountCache.set(container, {
                version: container.childElementCount,
                count
            });
            return count;
        },
        invalidateCache() {
            this.gridCache = new WeakMap();
            this.cardsCache = new WeakMap();
            this.linkCountCache = new WeakMap();
        },
        onBadgeCreated(badge) {
            const link = badge.querySelector('.profit-helper-badge-link') || badge;
            link.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (link.href) window.open(link.href, '_blank', 'noopener');
            });
        },
        markCard(card) {
            card?.setAttribute?.(this.cardAttribute, 'true');
            return card;
        },
        getMarkedCards(root = document) {
            return Array.from(root.querySelectorAll?.(`[${this.cardAttribute}="true"]`) || [])
                .filter(card => card.isConnected && !this.isIgnoredContainer(card));
        },
        getMarkedGrid(root = document) {
            const markedGrid = root.querySelector?.(`[${this.gridAttribute}="true"]`);
            if (markedGrid?.isConnected && !this.isIgnoredContainer(markedGrid)) return markedGrid;

            const counts = new Map();
            this.getMarkedCards(root).forEach(card => {
                const parent = card.parentElement;
                if (!parent || this.isIgnoredContainer(parent)) return;
                counts.set(parent, (counts.get(parent) || 0) + 1);
            });

            let bestGrid = null;
            let bestCount = 0;
            counts.forEach((count, grid) => {
                if (count > bestCount) {
                    bestGrid = grid;
                    bestCount = count;
                }
            });
            return bestGrid;
        },
        getGrid(root = document) {
            if (root === document) {
                const markedGrid = this.getMarkedGrid(root);
                if (markedGrid) return this.setCachedGrid(root, markedGrid);
            }

            const cached = this.getCachedGrid(root);
            if (cached) return cached;

            const scope = this.getScope(root);
            if (!scope) return null;

            const counts = new Map();
            this.getItemLinks(scope).forEach(link => {
                const card = this.getCardRoot(link, scope);
                const grid = card.parentElement;
                if (!grid || this.isIgnoredContainer(grid)) return;
                counts.set(grid, (counts.get(grid) || 0) + 1);
            });

            let bestGrid = null;
            let bestCount = 0;
            counts.forEach((count, grid) => {
                if (count > bestCount) {
                    bestGrid = grid;
                    bestCount = count;
                }
            });

            if (bestCount < 2) return null;
            if (root === document) bestGrid.setAttribute(this.gridAttribute, 'true');
            return this.setCachedGrid(root, bestGrid);
        },
        getCards(root = document) {
            if (root === document) {
                const markedCards = this.getMarkedCards(root);
                if (markedCards.length) return markedCards;
            }

            const grid = this.getGrid(root);
            if (grid) {
                const cards = this.getCardsFromContainer(grid);
                this.rememberCardTemplate(root, cards);
                return cards;
            }

            const scope = this.getScope(root);
            const cards = scope ? this.getCardsFromContainer(scope) : [];
            this.rememberCardTemplate(root, cards);
            return cards;
        },
        rememberCardTemplate(root, cards) {
            if (this.cardTemplate || root !== document || !cards[0]) return;
            this.cardTemplate = cards[0].cloneNode(true);
            this.cardTemplate.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
        },
        getCardsFromContainer(container) {
            const cached = this.getCachedCards(container);
            if (cached) return cached;

            const cards = uniqueElements(this.getItemLinks(container)
                .map(link => this.getCardRoot(link, container))
                .filter(card => this.isCardNode(card)))
                .map(card => this.markCard(card));
            return this.setCachedCards(container, cards);
        },
        getCardRoot(element, boundary) {
            let best = element;
            for (let current = element, depth = 0; current?.parentElement && depth < 6; current = current.parentElement, depth++) {
                if (this.isIgnoredContainer(current)) break;
                if (this.isCardNode(current)) best = current;

                const parent = current.parentElement;
                if (parent === boundary || parent === document.body || parent.matches?.('main')) break;
                if (this.getItemLinksCount(parent) >= 2) return best;
            }

            return best;
        },
        isCardNode(card) {
            if (!(card instanceof Element)) return false;
            if (this.isIgnoredContainer(card)) return false;
            if (card.hasAttribute(this.cardAttribute)) return true;
            if (card.querySelectorAll('a[href*="/market/"]').length > 1) return false;

            const hasVisual = Boolean(card.querySelector('img'));
            const hasPrice = isValidPrice(this.getPrice(card));
            const hasName = Boolean(this.getName(card));
            return hasVisual && hasPrice && hasName;
        },
        ownsCard(card) {
            return Boolean(!this.isIgnoredContainer(card) && this.isCardNode(card));
        },
        cleanName(value) {
            return normalizeText(String(value || '')
                .replace(/\bimage\b\s*$/iu, '')
                .replace(/(?:купить\s+сейчас|buy\s+now).*$/iu, '')
                .replace(/(?:[$€₽₴₸]\s*)?\d[\d\s.,]*\s*(?:[$€₽₴₸]|USD|RUB|UAH|KZT|EUR).*$/iu, ''));
        },
        getPrimaryItemLink(card) {
            if (card.matches?.('a[href*="/market/"]')) return card;
            return card.querySelector?.('a[href*="/market/"]') || null;
        },
        getNameAttribute(element) {
            return normalizeText(element?.getAttribute?.(ATTRIBUTE.marketHashName)
                || element?.getAttribute?.('data-market-hash-name')
                || element?.getAttribute?.('data-item-name')
                || element?.getAttribute?.('data-name')
                || element?.getAttribute?.('title')
                || element?.getAttribute?.('aria-label')
                || '');
        },
        getNameText(element) {
            if (!element) return '';
            return this.cleanName(this.getNameAttribute(element) || getDirectText(element));
        },
        isNameCandidate(element, text) {
            if (!element || element.closest?.('#profit-helper-panel, button, [role="button"], .steam-highest-buy-order-link')) return false;

            const value = this.cleanName(text);
            if (!value || value.length < 2 || value.length > 90) return false;
            if (!/[A-Za-zА-Яа-я]/.test(value)) return false;
            if (/[₽$€₴₸%]/.test(value)) return false;
            if (/^(x\d+|\d+\s*(?:шт|pcs?)\.?|избранное|favorite|купить|buy|cart|rust)$/iu.test(value)) return false;
            return true;
        },
        getNameElement(card) {
            if (this.nameElementCache.has(card)) return this.nameElementCache.get(card);

            const selectors = [
                `[${ATTRIBUTE.marketHashName}]`,
                '[data-market-hash-name]',
                '[data-item-name]',
                '[data-name]',
                '[class*="name" i]',
                '[class*="title" i]',
                'a[href*="/market/"] div',
                'a[href*="/market/"] span',
                'div',
                'span'
            ];
            const elements = uniqueElements(selectors.flatMap(selector => Array.from(card.querySelectorAll?.(selector) || [])));
            const nameElement = elements.find(element => this.isNameCandidate(element, this.getNameText(element))) || null;
            this.nameElementCache.set(card, nameElement);
            return nameElement;
        },
        getName(card) {
            const storedName = this.cleanName(card.getAttribute(ATTRIBUTE.marketHashName));
            if (storedName) return storedName;
            if (this.nameCache.has(card)) return this.nameCache.get(card);

            const link = this.getPrimaryItemLink(card);
            const linkName = this.cleanName(this.getNameAttribute(link));
            if (linkName && this.isNameCandidate(link, linkName)) {
                this.nameCache.set(card, linkName);
                return linkName;
            }

            const nameElement = this.getNameElement(card);
            const elementName = this.getNameText(nameElement);
            if (elementName) {
                this.nameCache.set(card, elementName);
                return elementName;
            }

            const imageName = this.cleanName(link?.querySelector('img')?.getAttribute('alt'));
            this.nameCache.set(card, imageName);
            return imageName;
        },
        normalizeSteamMarketHashName(marketHashName, appId) {
            let normalized = normalizeText(marketHashName);
            if (appId !== 730) return normalized;

            normalized = normalized.replace(/\s+\(Not Painted\)$/i, '');
            normalized = normalized.replace(/^StatTrak™?\s+★\s+/i, '★ StatTrak™ ');
            normalized = normalized.replace(/^★\s+StatTrak™?\s+StatTrak™?\s+/i, '★ StatTrak™ ');
            normalized = normalized.replace(/^Souvenir\s+★\s+/i, '★ Souvenir ');
            normalized = normalized.replace(/^★\s+Souvenir\s+Souvenir\s+/i, '★ Souvenir ');
            normalized = normalized.replace(/^Souvenir\s+(.+\s+Souvenir\s+(?:Highlight\s+)?Package)$/i, '$1');
            normalized = normalized.replace(
                /\b(Gamma Doppler)\s+(Emerald|Phase\s*[1-4])(?=\s*(?:\(|$))/i,
                '$1'
            );
            normalized = normalized.replace(
                /\b(Doppler)\s+(Ruby|Sapphire|Black Pearl|Phase\s*[1-4])(?=\s*(?:\(|$))/i,
                '$1'
            );

            return normalizeText(normalized);
        },
        getCsExteriorText(card) {
            if (this.csExteriorCache.has(card)) return this.csExteriorCache.get(card);

            const cardText = normalizeText(card.textContent);
            const fullWearMatch = cardText.match(/\b(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\b/i);
            if (fullWearMatch) {
                this.csExteriorCache.set(card, fullWearMatch[1]);
                return fullWearMatch[1];
            }

            const wearAliases = {
                FN: 'Factory New',
                MW: 'Minimal Wear',
                FT: 'Field-Tested',
                WW: 'Well-Worn',
                BS: 'Battle-Scarred'
            };
            const shortWearMatch = cardText.match(/(?:^|[\s/|])(?:FN|MW|FT|WW|BS)(?=$|[\s/|])/i);
            if (shortWearMatch) {
                const exterior = wearAliases[shortWearMatch[0].replace(/[\s/|]/g, '').toUpperCase()] || '';
                this.csExteriorCache.set(card, exterior);
                return exterior;
            }

            const elementWear = Array.from(card.querySelectorAll('*'))
                .map(element => normalizeText(getDirectText(element)).toUpperCase())
                .find(value => wearAliases[value]);
            const exterior = elementWear ? wearAliases[elementWear] : '';
            this.csExteriorCache.set(card, exterior);
            return exterior;
        },
        getCsExteriorCategoryValue(exteriorText) {
            const exteriorCategories = {
                'factory new': 'WearCategory0',
                'minimal wear': 'WearCategory1',
                'field-tested': 'WearCategory2',
                'well-worn': 'WearCategory3',
                'battle-scarred': 'WearCategory4'
            };
            return exteriorCategories[normalizeText(exteriorText).toLowerCase()] || '';
        },
        getNameCandidates(card) {
            const rootCandidates = [];
            const nestedCandidates = [];
            const addCandidate = (target, value) => {
                const normalized = this.cleanName(value);
                if (normalized) target.push(normalized);
            };

            ['data-market-hash-name', 'data-market-name', 'data-item-name', 'data-name', 'data-title', 'aria-label']
                .forEach(attr => addCandidate(rootCandidates, card.getAttribute?.(attr)));

            card.querySelectorAll?.('[data-market-hash-name], [data-market-name], [data-item-name], [data-name], [data-title], [aria-label], img[alt], img[title], a[title]')?.forEach(element => {
                ['data-market-hash-name', 'data-market-name', 'data-item-name', 'data-name', 'data-title', 'aria-label', 'alt', 'title']
                    .forEach(attr => addCandidate(nestedCandidates, element.getAttribute?.(attr)));
            });

            const titleText = this.getNameText(this.getNameElement(card));
            return { rootCandidates, titleText, nestedCandidates };
        },
        getBestMarketHashName(card, appId) {
            if (appId !== 730) return this.getName(card);

            const { rootCandidates, titleText, nestedCandidates } = this.getNameCandidates(card);
            const wearPattern = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;
            const allCandidates = [...rootCandidates, titleText, ...nestedCandidates].filter(Boolean);

            return allCandidates.find(candidate => wearPattern.test(candidate))
                || rootCandidates[0]
                || titleText
                || nestedCandidates.sort((a, b) => b.length - a.length)[0]
                || this.getName(card);
        },
        getCsCardTextValues(card) {
            const cached = this.csTextValuesCache.get(card);
            if (cached) return cached;

            const values = [];
            const addValue = value => {
                const normalized = normalizeText(value);
                if (normalized) values.push(normalized);
            };

            [card, ...Array.from(card.querySelectorAll('*'))].forEach(element => {
                addValue(getDirectText(element));
                ['data-weapon', 'data-type', 'data-title', 'title', 'aria-label']
                    .forEach(attribute => addValue(element.getAttribute?.(attribute)));
            });
            const uniqueValues = Array.from(new Set(values));
            this.csTextValuesCache.set(card, uniqueValues);
            return uniqueValues;
        },
        getCsItemModel(card) {
            const values = this.getCsCardTextValues(card);

            for (const value of values) {
                const cleanValue = value
                    .replace(/^★\s*/, '')
                    .replace(/^(?:ST™?|StatTrak™?|SV|Souvenir)\s+/i, '');
                const model = CS2_ITEM_MODELS.get(cleanValue.toLowerCase());
                if (model) return model;
            }
            return '';
        },
        getCsMarketType(card) {
            const typePattern = /^(Sticker|Patch|Charm|Music Kit|Sealed Graffiti|Graffiti)(?:\s*\|\s*(.+))?$/i;
            for (const value of this.getCsCardTextValues(card)) {
                const match = value.match(typePattern);
                if (!match) continue;

                const canonicalTypes = {
                    sticker: 'Sticker',
                    patch: 'Patch',
                    charm: 'Charm',
                    'music kit': 'Music Kit',
                    'sealed graffiti': 'Sealed Graffiti',
                    graffiti: 'Sealed Graffiti'
                };
                return {
                    type: canonicalTypes[match[1].toLowerCase()],
                    collection: normalizeText(match[2])
                };
            }
            return null;
        },
        getCsItemQuality(card) {
            const values = this.getCsCardTextValues(card);
            if (values.some(value => /(?:^|\s)(?:ST™?|StatTrak™?)(?=\s|$)/i.test(value))) return 'stattrak';
            if (values.some(value => /(?:^|\s)(?:SV|Souvenir)(?=\s|$)/i.test(value))) return 'souvenir';
            return '';
        },
        composeCsMarketHashName(card, itemName) {
            const normalizedName = normalizeText(itemName);
            if (!normalizedName || normalizedName.includes('|')) return normalizedName;

            const marketType = this.getCsMarketType(card);
            if (marketType && normalizedName.toLowerCase() !== marketType.type.toLowerCase()) {
                const collectionSuffix = marketType.collection ? ` | ${marketType.collection}` : '';
                return `${marketType.type} | ${normalizedName}${collectionSuffix}`;
            }

            const itemModel = this.getCsItemModel(card);
            if (!itemModel || normalizedName.replace(/^★\s*/, '').toLowerCase() === itemModel.replace(/^★\s*/, '').toLowerCase()) {
                return normalizedName;
            }
            if (normalizedName.toLowerCase().startsWith(`${itemModel.toLowerCase()} `)) return normalizedName;

            return `${itemModel} | ${normalizedName}`;
        },
        getSteamMarketHashName(card) {
            const appId = this.getAppId();
            let itemName = this.getBestMarketHashName(card, appId);
            if (!itemName || appId !== 730) return this.normalizeSteamMarketHashName(itemName, appId);

            itemName = this.composeCsMarketHashName(card, itemName);

            const cardText = normalizeText(card.textContent);
            const exteriorText = this.getCsExteriorText(card);
            const wearPattern = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;
            const hasStatTrakPrefix = /^StatTrak™?\s+/i.test(itemName) || /^★\s+StatTrak™?\s+/i.test(itemName);
            const hasSouvenirPrefix = /^Souvenir\s+/i.test(itemName) || /^★\s+Souvenir\s+/i.test(itemName);
            const itemQuality = this.getCsItemQuality(card);

            if ((itemQuality === 'stattrak' || /StatTrak™?/i.test(cardText)) && !hasStatTrakPrefix) {
                itemName = `StatTrak™ ${itemName}`;
            } else if ((itemQuality === 'souvenir' || /Souvenir/i.test(cardText)) && !hasSouvenirPrefix) {
                itemName = `Souvenir ${itemName}`;
            }

            if (exteriorText && !wearPattern.test(itemName)) {
                itemName = `${itemName} (${exteriorText})`;
            }

            return this.normalizeSteamMarketHashName(itemName, appId);
        },
        getSteamListingSearchParams(card) {
            const appId = this.getAppId();
            if (appId !== 730) return null;

            const exteriorCategory = this.getCsExteriorCategoryValue(this.getCsExteriorText(card));
            return exteriorCategory ? { category_Exterior: exteriorCategory } : null;
        },
        getSteamListingUrl(card, marketHashName) {
            return buildSteamListingUrl(this.getAppId(), marketHashName, this.getSteamListingSearchParams(card));
        },
        getPriceElement(card) {
            const selectors = ['[data-price]', '.price', '[class*="price" i]', 'div', 'span'];
            const elements = uniqueElements(selectors.flatMap(selector => Array.from(card.querySelectorAll?.(selector) || [])));
            return elements.find(element => isValidPrice(parsePrice(element.getAttribute?.(ATTRIBUTE.price) || getDirectText(element) || element.textContent))) || null;
        },
        getPrice(card) {
            const storedPrice = parsePrice(card.getAttribute(ATTRIBUTE.price));
            if (isValidPrice(storedPrice)) return storedPrice;
            if (this.priceCache.has(card)) return this.priceCache.get(card);

            const exactPrice = parsePrice(firstText(card, ['[data-price]', '.price', '[class*="price" i]']));
            if (isValidPrice(exactPrice)) {
                this.priceCache.set(card, exactPrice);
                return exactPrice;
            }

            const text = normalizeText(card.textContent);
            const priceMatch = text.match(/(?:[$€₽₴₸]\s*)?\d[\d\s.,]*\s*(?:[$€₽₴₸]|USD|RUB|UAH|KZT|EUR)/i);
            const price = parsePrice(priceMatch?.[0] || text);
            this.priceCache.set(card, price);
            return price;
        },
        getDiscount(card) {
            const storedDiscount = parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount));
            if (storedDiscount !== null) return storedDiscount;
            if (this.discountCache.has(card)) return this.discountCache.get(card);

            const exactDiscount = parseDiscountPercent(firstText(card, [
                '[class*="discount" i]',
                '[class*="sale" i]',
                '[class*="percent" i]'
            ]));
            if (exactDiscount !== null) {
                this.discountCache.set(card, exactDiscount);
                return exactDiscount;
            }

            const discount = parseDiscountPercent(card.textContent);
            this.discountCache.set(card, discount);
            return discount;
        },
        getItemHrefFromName(name) {
            return buildSteamListingUrl(this.getAppId(), name);
        },
        getImageUrl(card) {
            return Array.from(card.querySelectorAll?.('img') || [])
                .map(img => img.currentSrc
                    || img.getAttribute('src')
                    || img.getAttribute('data-src')
                    || img.getAttribute('data-lazy-src')
                    || img.getAttribute('data-profit-original-src')
                    || img.getAttribute('data-profit-original-data-src')
                    || '')
                .find(src => src && !/^data:/i.test(src)) || '';
        },
        getLoadedItemContainer(link, boundary) {
            let best = link;
            for (let current = link; current?.parentElement && current !== boundary; current = current.parentElement) {
                if (this.isIgnoredContainer(current)) break;
                const hasImage = Boolean(current.querySelector?.('img'));
                const hasPrice = isValidPrice(this.getPrice(current));
                if (hasImage && hasPrice) best = current;
                if (current.parentElement === boundary || current.parentElement?.matches?.('main')) break;
            }
            return best;
        },
        extractItems(doc) {
            const scope = this.getScope(doc) || doc;
            const links = Array.from(scope.querySelectorAll?.('a[href*="/market/"]') || [])
                .filter(link => !this.isIgnoredContainer(link));
            const items = [];
            const seen = new Set();

            links.forEach(link => {
                const directName = this.getNameText(link) || this.getNameText(this.getNameElement(link));
                const href = link.href || link.getAttribute('href') || '';
                if (!directName || !this.isNameCandidate(link, directName)) return;
                if (/\/market\/[^/]+\/?$/i.test(new URL(href, window.location.origin).pathname)) return;

                const card = this.getLoadedItemContainer(link, scope);
                const price = this.getPrice(card);
                if (!isValidPrice(price)) return;

                const imageUrl = this.getImageUrl(card);
                const discount = this.getDiscount(card);
                const count = normalizeText(card.textContent).match(/\bx\s*(\d+)\b/iu)?.[1] || '';
                const key = `${directName}|${price}|${href}`;
                if (seen.has(key)) return;
                seen.add(key);
                items.push({
                    name: directName,
                    marketHashName: this.getSteamMarketHashName(card) || directName,
                    price,
                    imageUrl,
                    discount,
                    count,
                    href
                });
            });

            return items;
        },
        itemFromCard(card) {
            const name = this.getName(card);
            const price = this.getPrice(card);
            if (!name || !isValidPrice(price)) return null;

            const link = this.getPrimaryItemLink(card);
            const count = normalizeText(card.textContent).match(/\bx\s*(\d+)\b/iu)?.[1] || '';
            return {
                name,
                marketHashName: this.getSteamMarketHashName(card) || name,
                price,
                imageUrl: this.getImageUrl(card),
                discount: this.getDiscount(card),
                count,
                href: link?.href || link?.getAttribute?.('href') || ''
            };
        },
        importLoadedCard(card) {
            const item = this.itemFromCard(card);
            parkCardImages(card);
            const importedCard = document.importNode(card, true);
            this.resetGeneratedCard(importedCard);
            this.markCard(importedCard);

            if (item) {
                importedCard.setAttribute(ATTRIBUTE.marketHashName, item.marketHashName);
                importedCard.setAttribute(ATTRIBUTE.price, String(item.price));
                if (item.discount !== null && item.discount !== undefined) {
                    importedCard.setAttribute(ATTRIBUTE.discount, String(item.discount));
                }
            }
            return importedCard;
        },
        resetGeneratedCard(card) {
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
            card.removeAttribute(ATTRIBUTE.processed);
            card.removeAttribute(ATTRIBUTE.filtered);
            card.removeAttribute(ATTRIBUTE.profit);
            card.removeAttribute(ATTRIBUTE.profitPercent);
            card.removeAttribute(ATTRIBUTE.result);
            card.removeAttribute(ATTRIBUTE.queued);
        },
        makeCard(item) {
            const card = this.cardTemplate
                ? this.cardTemplate.cloneNode(true)
                : document.createElement('a');
            this.resetGeneratedCard(card);

            if (!this.cardTemplate) {
                card.href = item.href || '#';
                card.innerHTML = '<img alt=""><div data-item-name></div><div data-price></div>';
            }

            this.markCard(card);
            card.setAttribute(ATTRIBUTE.marketHashName, item.marketHashName || item.name);
            card.setAttribute(ATTRIBUTE.price, String(item.price));
            if (item.discount !== null && item.discount !== undefined) card.setAttribute(ATTRIBUTE.discount, String(item.discount));

            const link = this.getPrimaryItemLink(card);
            const targetHref = item.href || this.getItemHrefFromName(item.name);
            if (card.matches?.('a[href*="/market/"]')) card.href = targetHref;
            if (link) link.href = targetHref;

            const img = card.querySelector('img');
            if (img && item.imageUrl) {
                img.src = item.imageUrl;
                img.removeAttribute('srcset');
                img.alt = item.name;
            }

            const nameElement = this.getNameElement(card) || card.querySelector('[data-item-name]');
            if (nameElement) nameElement.textContent = item.name;

            const priceElement = this.getPriceElement(card) || card.querySelector('[data-price]');
            if (priceElement) priceElement.textContent = formatCurrency(item.price);

            const countElement = Array.from(card.querySelectorAll('div, span'))
                .find(element => /^\s*x\s*\d+\s*$/iu.test(getDirectText(element)));
            if (countElement) countElement.textContent = item.count ? `x${item.count}` : '';

            return card;
        },
        async loadPage(pageNumber, context) {
            const baseUrl = context.baseUrl || (window.location.origin + window.location.pathname);
            const searchParams = context.searchParams || new URLSearchParams(window.location.search);
            const url = new URL(baseUrl);
            searchParams.forEach((value, key) => url.searchParams.set(key, value));
            url.searchParams.set('page', String(pageNumber));
            const fragment = await fetchInertHtmlFragment(url.toString(), { signal: context.signal });
            const cards = this.getCards(fragment);
            if (cards.length) {
                return {
                    page: pageNumber,
                    cards: cards.map(card => this.importLoadedCard(card))
                };
            }

            return {
                page: pageNumber,
                cards: this.extractItems(fragment).map(item => {
                    const card = this.makeCard(item);
                    parkCardImages(card);
                    return card;
                })
            };
        }
    };

    /*************************************************************************
     * Adapter: Avan
     *************************************************************************/

    const AvanAdapter = {
        id: 'avan',
        ignoredImageAlts: new Set(['flash', 'rust', 'csgo', 'cs2', 'dota 2', 'steam']),
        matches: () => window.location.hostname === 'avan.market' && window.location.pathname.includes('/market'),
        getAppId: () => detectAppId(730),
        getGrid: (root = document) => root.querySelector('[class*="marketArticlesContainer"]'),
        getCards(root = document) {
            const grid = this.getGrid(root);
            return Array.from(grid?.querySelectorAll(':scope > [class*="cardHovered"]') || []);
        },
        ownsCard(card) {
            return Boolean(card?.className?.includes?.('cardHovered'));
        },
        getName(card) {
            const marketNameElement = card.querySelector('[data-market-hash-name]');
            const storedName = normalizeText(card.getAttribute(ATTRIBUTE.marketHashName)
                || marketNameElement?.getAttribute('data-market-hash-name')
                || firstText(card, ['[class*="marketHashName"]'])
                || this.getImageName(card));
            if (storedName && !this.isCompositeText(storedName)) return storedName;
            if (storedName) {
                const cleanedStoredName = this.cleanCompositeName(storedName);
                if (cleanedStoredName) return cleanedStoredName;
            }

            const lines = normalizeText(card.innerText || card.textContent)
                .split(/\n|(?<=₽)|(?<=%)|(?=Разное|Оружие|Ресурсы|Одежда|Броня)/)
                .map(line => normalizeText(line.replace(/^(Разное|Оружие|Ресурсы|Одежда|Броня)\s*/, '')))
                .filter(Boolean);
            const categoryNames = new Set(['Разное', 'Оружие', 'Ресурсы', 'Одежда', 'Броня']);

            return lines.reverse().find(line => {
                if (categoryNames.has(line)) return false;
                if (/^(x\d+|нет заявок|загружаю)$/i.test(line)) return false;
                if (/^[⚡\s]+$/.test(line)) return false;
                if (/[₽%]/.test(line)) return false;
                return /[A-Za-zА-Яа-я]/.test(line);
            }) || '';
        },
        getImageName(card) {
            return Array.from(card.querySelectorAll('img[alt]'))
                .map(img => normalizeText(img.getAttribute('alt')))
                .find(alt => alt
                    && !this.ignoredImageAlts.has(alt.toLowerCase())
                    && !this.isCompositeText(alt)
                    && /[A-Za-zА-Яа-я]/.test(alt)) || '';
        },
        cleanCompositeName(text) {
            let value = normalizeText(text);
            value = value.replace(/^.*(?:Разное|Оружие|Ресурсы|Одежда|Броня)\s*/u, '');
            value = value.replace(/^.*[₽%]\s*/u, '');
            value = value.replace(/^(x\d+|нет заявок|загружаю)\s*/iu, '');
            return normalizeText(value);
        },
        isCompositeText(text) {
            return /[₽%]/.test(text) || /(Разное|Оружие|Ресурсы|Одежда|Броня)/.test(text);
        },
        getPrice(card) {
            return parsePrice(card.getAttribute(ATTRIBUTE.price)
                || firstText(card, ['[class*="marketGunCardPrice"] span', '[class*="marketGunCardPrice"]', '[class*="price" i]']));
        },
        getDiscount(card) {
            return parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount) || card.textContent);
        },
        buildPageUrl(pageNumber, context) {
            const url = new URL(context.baseUrl);
            const basePath = url.pathname.replace(/\/page-\d+\/?$/i, '').replace(/\/$/, '');
            url.pathname = `${basePath}/page-${pageNumber}`;
            context.searchParams.forEach((value, key) => url.searchParams.set(key, value));
            return url.toString();
        },
        async loadPage(pageNumber, context) {
            const url = this.buildPageUrl(pageNumber, context);
            const cards = await this.loadCardsFromFrame(url, context.signal);
            return { page: pageNumber, cards };
        },
        loadCardsFromFrame(url, signal) {
            const frame = document.createElement('iframe');
            frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;height:1000px;opacity:0;pointer-events:none;';
            frame.setAttribute('aria-hidden', 'true');

            return new Promise((resolve, reject) => {
                let finished = false;
                let pollId = null;

                const cleanup = () => {
                    if (pollId) clearInterval(pollId);
                    signal?.removeEventListener('abort', onAbort);
                    frame.remove();
                };
                const finish = cards => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    resolve(cards);
                };
                const fail = error => {
                    if (finished) return;
                    finished = true;
                    cleanup();
                    reject(error);
                };
                const collectCards = () => {
                    try {
                        const doc = frame.contentDocument;
                        const cards = doc ? this.getCards(doc) : [];
                        if (!cards.length) return;

                        finish(cards.map(card => document.importNode(card, true)));
                    } catch (error) {
                        fail(error);
                    }
                };
                const onAbort = () => finish([]);

                signal?.addEventListener('abort', onAbort, { once: true });
                frame.addEventListener('load', () => {
                    collectCards();
                    pollId = setInterval(collectCards, 250);
                }, { once: true });

                document.body.appendChild(frame);
                frame.src = url;
            });
        }
    };

    /*************************************************************************
     * Adapter: Tradeit
     *************************************************************************/

    const TradeitAdapter = {
        id: 'tradeit',
        pageLimit: 160,
        reloadInitialPage: true,
        cardTemplate: null,
        cardItemData: new WeakMap(),
        rubRate: NaN,
        rubRateFetchedAt: 0,
        rubRatePromise: null,
        rubRateTtlMs: 5 * 60 * 1000,
        matches: () => ['tradeit.gg', 'www.tradeit.gg'].includes(window.location.hostname)
            && Boolean(document.querySelector('.grid-items.store-grid .grid-row') || window.location.pathname.includes('/store')),
        getAppId: () => detectAppId(730),
        getStyles() {
            return `
                .tradeit-generated-card .item-cell {
                    position: relative !important;
                    overflow: visible !important;
                }
                .tradeit-generated-card .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                    top: 8px !important;
                    left: 8px !important;
                    right: 8px !important;
                    display: flex !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    pointer-events: auto !important;
                }
            `;
        },
        getGrid(root = document) {
            const candidates = [
                '#siteInventoryContainer .grid-items.store-grid .grid-row',
                '.grid-items.store-grid .grid-row'
            ];

            for (const selector of candidates) {
                const grids = Array.from(root.querySelectorAll(selector));
                const visibleGrid = grids.find(isElementVisible);
                if (visibleGrid) return visibleGrid;
            }

            return root.querySelector('#siteInventoryContainer .grid-items.store-grid .grid-row')
                || root.querySelector('.grid-items.store-grid .grid-row');
        },
        getCards(root = document) {
            const grid = this.getGrid(root);
            return Array.from(grid?.querySelectorAll(':scope > .grid-col, :scope > .tradeit-generated-card') || [])
                .filter(card => !card.classList.contains('show-banner'));
        },
        ownsCard(card) {
            return Boolean(card?.matches?.('.grid-col, .tradeit-generated-card') && card.closest('.grid-items.store-grid'));
        },
        getName(card) {
            return normalizeText(card.getAttribute(ATTRIBUTE.marketHashName)
                || firstText(card, [
                    '.item-name',
                    '.indicators .w-100.font-weight-bold',
                    '.indicators > div:not(.price):not(.buttons)',
                    '[class*="name" i]'
                ]));
        },
        getPrice(card) {
            return parsePrice(card.getAttribute(ATTRIBUTE.price)
                || firstText(card, ['.price .d-inline-block', '.price', '[class*="price"]']));
        },
        getDiscount(card) {
            return parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount) || card.textContent);
        },
        getBadgeContainer(card) {
            return card.querySelector('.item-cell')
                || card.querySelector('.item-container')
                || card.querySelector('.item-details')
                || card;
        },
        prepareReloadGrid(grid) {
            if (!grid) return grid;

            document.getElementById('profit-helper-tradeit-grid')?.remove();
            const cards = Array.from(grid.querySelectorAll(':scope > .grid-col, :scope > .tradeit-generated-card'));
            const nativeTemplate = cards.find(card => !card.classList.contains('tradeit-generated-card')
                && card.querySelector('.item-cell img')
                && card.querySelector('button[title="add to cart"]')
                && card.querySelector('button[title="more details"]'));
            if (nativeTemplate) this.cardTemplate = nativeTemplate.cloneNode(true);
            cards.forEach(card => card.remove());
            grid.closest('.grid-items.store-grid')?.style.removeProperty('display');
            return grid;
        },
        afterReset() {
            document.getElementById('profit-helper-tradeit-grid')?.remove();
            document.querySelectorAll('.tradeit-generated-card').forEach(card => card.remove());
            document.querySelectorAll('.grid-items.store-grid').forEach(grid => grid.style.removeProperty('display'));
        },
        getSteamCommunityAppId(item) {
            const classId = getDeepValue(item, ['classId', 'classID', 'class_id', 'classid']);
            const match = String(classId || '').match(/(?:^|_)(\d+)$/);
            return match ? match[1] : '';
        },
        getItemName(item) {
            const rawName = getDeepValue(item, ['marketHashName', 'market_hash_name', 'marketName', 'market_name', 'name', 'title']);
            const name = normalizeText(rawName);
            if (this.getAppId() !== 753 || !name || /^\d+-/.test(name)) return name;

            const communityAppId = this.getSteamCommunityAppId(item);
            return communityAppId ? `${communityAppId}-${name}` : name;
        },
        getStorePrice(item) {
            return parsePrice(getDeepValue(item, ['storePrice', 'priceForSale', 'priceForTrade', 'sitePrice', 'price']));
        },
        getNuxtApp() {
            try {
                return window.useNuxtApp?.() || window.$nuxt || null;
            } catch (_) {
                return window.$nuxt || null;
            }
        },
        getPiniaStore(id) {
            return this.getNuxtApp()?.$pinia?._s?.get?.(id) || null;
        },
        getRuntimeRubRate() {
            const currencyStore = this.getPiniaStore('currency');
            const ratesRub = Number(currencyStore?.rates?.RUB);
            if (isValidPrice(ratesRub)) return ratesRub;

            const selectedRate = Number(currencyStore?.selectedRate);
            return currencyStore?.selectedCurrency === 'RUB' && isValidPrice(selectedRate)
                ? selectedRate
                : NaN;
        },
        async ensureRubRate(signal) {
            const runtimeRate = this.getRuntimeRubRate();
            if (isValidPrice(runtimeRate)) {
                this.rubRate = runtimeRate;
                this.rubRateFetchedAt = Date.now();
                return runtimeRate;
            }

            if (isValidPrice(this.rubRate) && Date.now() - this.rubRateFetchedAt < this.rubRateTtlMs) {
                return this.rubRate;
            }
            if (this.rubRatePromise) return this.rubRatePromise;

            this.rubRatePromise = fetchJson(new URL('/api/v2/exchange-rate', window.location.origin).toString(), {
                signal,
                credentials: 'include'
            }).then(data => {
                const rate = Number(data?.rates?.RUB);
                if (!isValidPrice(rate)) throw new Error('Tradeit не вернул курс RUB');

                this.rubRate = rate;
                this.rubRateFetchedAt = Date.now();
                logWork('INFO', 'Загружен курс Tradeit', { currency: 'RUB', rate });
                return rate;
            }).finally(() => {
                this.rubRatePromise = null;
            });

            return this.rubRatePromise;
        },
        convertStorePrice(rawPrice) {
            if (!isValidPrice(this.rubRate)) return NaN;
            return Math.round((rawPrice / 100) * this.rubRate * 100) / 100;
        },
        getStoreDiscount(item) {
            const explicitDiscount = getDeepValue(item, ['discount', 'discountPercent', 'discountPercentage', 'overstockDiffPercentage']);
            if (Number.isFinite(Number(explicitDiscount)) && Math.abs(Number(explicitDiscount)) > 0) {
                return Math.round(Math.abs(Number(explicitDiscount)));
            }

            const basePrice = parsePrice(getDeepValue(item, ['storeBasePrice', 'basePrice', 'price', 'sitePrice', 'priceForTrade']));
            const storePrice = parsePrice(getDeepValue(item, ['storePrice', 'priceForSale']));
            if (!isValidPrice(basePrice) || !isValidPrice(storePrice) || storePrice >= basePrice) return null;

            return Math.round(((basePrice - storePrice) / basePrice) * 100);
        },
        setCardData(card, { name, displayName, price, imageUrl, discount, count }) {
            card.classList.add('tradeit-generated-card');
            card.classList.remove('show-banner');
            card.setAttribute(ATTRIBUTE.marketHashName, name);
            card.setAttribute(ATTRIBUTE.price, String(price));
            if (discount !== null && discount > 0) card.setAttribute(ATTRIBUTE.discount, `-${discount}%`);
            else card.removeAttribute(ATTRIBUTE.discount);
            [ATTRIBUTE.processed, ATTRIBUTE.filtered, ATTRIBUTE.profit, ATTRIBUTE.profitPercent, ATTRIBUTE.result, ATTRIBUTE.queued].forEach(attribute => {
                card.removeAttribute(attribute);
            });
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());

            const image = card.querySelector('img.item-image, img[alt="item image"]');
            if (image && imageUrl) image.src = imageUrl;
            if (image) image.alt = 'item image';

            const nameElement = card.querySelector('.indicators .w-100.font-weight-bold, .item-name, .indicators > div:not(.price):not(.buttons)');
            if (nameElement) nameElement.textContent = displayName;

            const priceElement = card.querySelector('.price .d-inline-block, .price');
            if (priceElement) priceElement.textContent = formatCurrency(price);

            let discountElement = card.querySelector('.discount');
            if (!discountElement && discount !== null && discount > 0) {
                const priceContainer = card.querySelector('.price');
                if (priceContainer) {
                    discountElement = document.createElement('div');
                    discountElement.className = 'discount font-size-12 d-inline-block rounded ml-2 px-1 good-discount secondary-green-500--text';
                    discountElement.style.lineHeight = '22px';
                    priceContainer.appendChild(discountElement);
                }
            }
            if (discountElement) {
                if (discount !== null && discount > 0) {
                    discountElement.textContent = `-${discount}%`;
                    discountElement.style.display = '';
                } else {
                    discountElement.style.display = 'none';
                }
            }

            const countElement = card.querySelector('.count span');
            const countWrapper = card.querySelector('.count');
            if (countElement && countWrapper) {
                if (count > 1) {
                    countElement.textContent = `x${count}`;
                    countWrapper.style.display = '';
                } else {
                    countWrapper.style.display = 'none';
                }
            }
        },
        getInventoryStore() {
            return this.getPiniaStore('inventory');
        },
        async loadGroupItems(item, limit = this.pageLimit) {
            if (getDeepValue(item, ['assetId', 'assetID', 'asset_id'])) return [item];

            const groupId = getDeepValue(item, ['groupId', 'groupID', 'group_id']);
            if (groupId === null || groupId === undefined || groupId === '') {
                return [];
            }

            const inventoryStore = this.getInventoryStore();
            if (typeof inventoryStore?.loadSiteInventory === 'function') {
                const result = await inventoryStore.loadSiteInventory({
                    fresh: true,
                    groupId,
                    isForStore: true,
                    offset: 0,
                    limit
                });
                if (Array.isArray(result?.items)) return result.items;
            }

            const url = new URL(this.buildUrl(1));
            url.searchParams.set('groupId', String(groupId));
            url.searchParams.set('offset', '0');
            url.searchParams.set('limit', String(limit));
            const data = await fetchJson(url.toString(), { credentials: 'include' });
            return this.findItems(data);
        },
        makeCartItem(item) {
            const imageUrl = normalizeText(getDeepValue(item, ['imgURL', 'image', 'imageUrl', 'imageURL', 'img', 'imgUrl', 'iconUrl', 'iconURL']));
            const assetId = String(getDeepValue(item, ['assetId', 'assetID', 'asset_id']) || '');
            const groupId = getDeepValue(item, ['groupId', 'groupID', 'group_id']);
            const storePrice = this.getStorePrice(item);
            const price = parsePrice(getDeepValue(item, ['price', 'priceForTrade', 'sitePrice'])) || storePrice;
            const formattedStorePrice = formatCurrency(this.convertStorePrice(storePrice));
            const formattedPrice = formatCurrency(this.convertStorePrice(price));
            const imgUrls = imageUrl ? {
                gridImgUrl: imageUrl,
                mobileGridImgUrl: imageUrl,
                infoImgUrl: imageUrl,
                mobileInfoImgUrl: imageUrl,
                cartImgUrl: imageUrl,
                mobileCartImgUrl: imageUrl
            } : {};

            return {
                ...item,
                count: 1,
                originalPrice: price,
                checkoutPrice: storePrice,
                isTradeAway: false,
                itemKey: `siteInventory-${groupId}-${assetId}`,
                formattedPrice,
                formattedSitePrice: formattedPrice,
                formattedStorePrice,
                imgUrls
            };
        },
        async addCardItemToCart(card, button) {
            const groupedItem = this.cardItemData.get(card);
            if (!groupedItem) throw new Error('данные карточки недоступны');

            button.disabled = true;
            try {
                const inventoryStore = this.getInventoryStore();
                const selectedItems = inventoryStore?.siteInventory?.storeSelectedItems;
                if (!Array.isArray(selectedItems)) throw new Error('корзина Tradeit недоступна');

                const loadedItems = await this.loadGroupItems(groupedItem, Math.min(this.pageLimit, 40));
                const selectedAssetIds = new Set(selectedItems.map(item => String(item.assetId || '')));
                const item = loadedItems
                    .filter(candidate => !selectedAssetIds.has(String(candidate.assetId || '')))
                    .sort((a, b) => this.getStorePrice(a) - this.getStorePrice(b))[0];
                if (!item) throw new Error('нет свободных экземпляров');

                selectedItems.push(this.makeCartItem(item));
                logWork('INFO', 'Предмет Tradeit добавлен в корзину', {
                    cardName: this.getItemName(item),
                    assetId: item.assetId
                });
                showToast('Предмет добавлен в корзину Tradeit.');
            } finally {
                button.disabled = false;
            }
        },
        async expandCardGroup(card, button) {
            const groupedItem = this.cardItemData.get(card);
            if (!groupedItem) throw new Error('данные карточки недоступны');
            if (getDeepValue(groupedItem, ['assetId', 'assetID', 'asset_id'])) return;

            button.disabled = true;
            try {
                const items = await this.loadGroupItems(groupedItem, this.pageLimit);
                if (!items.length) throw new Error('экземпляры не найдены');

                const fragment = document.createDocumentFragment();
                items.forEach(item => {
                    const expandedCard = this.makeCard(item);
                    if (expandedCard) fragment.appendChild(expandedCard);
                });
                if (!fragment.childNodes.length) throw new Error('не удалось создать карточки');

                card.replaceWith(fragment);
                logWork('INFO', 'Группа Tradeit развернута', {
                    cardName: this.getItemName(groupedItem),
                    items: items.length
                });
            } finally {
                button.disabled = false;
            }
        },
        bindCardActions(card, item) {
            this.cardItemData.set(card, item);
            const addButton = card.querySelector('button[title="add to cart"], .buttons button:first-child');
            const expandButton = card.querySelector('button[title="more details"], .more-btn, .buttons button:last-child');
            const isIndividualItem = Boolean(getDeepValue(item, ['assetId', 'assetID', 'asset_id']));

            if (addButton) {
                addButton.title = 'Добавить в корзину';
                addButton.disabled = false;
                addButton.removeAttribute('aria-disabled');
                addButton.classList.remove('v-btn--disabled');
                addButton.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.addCardItemToCart(card, addButton).catch(error => {
                        logWork('ERROR', 'Ошибка добавления Tradeit в корзину', {
                            cardName: this.getItemName(item),
                            error: error.message || String(error)
                        });
                        showToast(`Tradeit: ${error.message || 'ошибка корзины'}`, 'error');
                    });
                });
            }

            if (expandButton) {
                expandButton.title = isIndividualItem ? 'Карточка экземпляра' : 'Развернуть группу';
                expandButton.disabled = isIndividualItem;
                expandButton.classList.toggle('v-btn--disabled', isIndividualItem);
                if (!isIndividualItem) expandButton.removeAttribute('aria-disabled');
                if (isIndividualItem) expandButton.style.display = 'none';
                else {
                    expandButton.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        this.expandCardGroup(card, expandButton).catch(error => {
                            logWork('ERROR', 'Ошибка раскрытия группы Tradeit', {
                                cardName: this.getItemName(item),
                                error: error.message || String(error)
                            });
                            showToast(`Tradeit: ${error.message || 'ошибка раскрытия'}`, 'error');
                        });
                    });
                }
            }
        },
        getItemCount(item, counts = {}) {
            const explicitCount = getDeepValue(item, ['count', 'amount', 'quantity', 'qty', 'stackSize']);
            if (Number.isFinite(Number(explicitCount))) return Number(explicitCount);

            const groupId = getDeepValue(item, ['groupId', 'groupID', 'group_id']);
            const groupedCount = groupId !== null && groupId !== undefined ? counts[String(groupId)] : null;
            return Number.isFinite(Number(groupedCount)) ? Number(groupedCount) : 0;
        },
        makeCard(item, counts = {}) {
            const name = this.getItemName(item);
            const displayName = normalizeText(getDeepValue(item, ['displayName', 'display_name', 'shortName', 'short_name', 'name']) || name.replace(/^\d+-/, ''));
            const rawPrice = this.getStorePrice(item);
            if (!name || !isValidPrice(rawPrice)) return null;
            const price = this.convertStorePrice(rawPrice);

            const imageValue = getDeepValue(item, ['imgURL', 'image', 'imageUrl', 'imageURL', 'img', 'imgUrl', 'iconUrl', 'iconURL']);
            const imageUrl = imageValue
                ? (/^https?:\/\//i.test(String(imageValue)) ? String(imageValue) : `${STEAM_IMAGE_BASE_URL}${String(imageValue).replace(/^\/+/, '')}`)
                : '';
            const discount = this.getStoreDiscount(item);
            const count = this.getItemCount(item, counts);

            const card = this.cardTemplate?.cloneNode(true) || document.createElement('div');
            if (!this.cardTemplate) {
                card.className = 'grid-col tradeit-generated-card';
                card.innerHTML = `
                    <div class="item-cell item item-md rounded gray-700">
                        <div class="item-container">
                            <div class="item-details d-flex justify-center p-relative overflow-hidden gray-600 rounded pa-3 hoverable">
                                ${imageUrl ? `<img alt="item image" class="item-image d-flex align-self-start mt-0 mt-md-3" src="${escapeHtml(imageUrl)}">` : ''}
                                <div class="indicators px-3 d-flex flex-column justify-end">
                                    <div class="item-name font-weight-bold primary-400--text font-size-14 overflow-ellipsis"></div>
                                    <div class="price gray-200--text font-weight-bold font-size-16 d-flex align-center">
                                        <div class="d-inline-block"></div>
                                        <div class="discount font-size-12 d-inline-block rounded ml-2 px-1 good-discount secondary-green-500--text"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }
            this.setCardData(card, { name, displayName, price, imageUrl, discount, count });
            this.bindCardActions(card, item);
            return card;
        },
        findItems(data, depth = 0) {
            if (!data || depth > 6) return [];
            if (Array.isArray(data)) {
                const usable = data.filter(item => this.getItemName(item) && isValidPrice(this.getStorePrice(item)));
                if (usable.length) return data;
                return data.reduce((best, value) => {
                    const nested = this.findItems(value, depth + 1);
                    return nested.length > best.length ? nested : best;
                }, []);
            }
            if (typeof data === 'object') {
                return Object.values(data).reduce((best, value) => {
                    const nested = this.findItems(value, depth + 1);
                    return nested.length > best.length ? nested : best;
                }, []);
            }
            return [];
        },
        buildUrl(pageNumber) {
            const limit = this.pageLimit;
            const url = new URL('/api/v2/inventory/data', window.location.origin);
            url.searchParams.set('gameId', String(this.getAppId()));
            url.searchParams.set('sortType', 'Popularity');
            url.searchParams.set('searchValue', '');
            url.searchParams.set('minFloat', '0');
            url.searchParams.set('maxFloat', '1');
            url.searchParams.set('showTradeLock', 'true');
            url.searchParams.set('onlyTradeLock', 'false');
            url.searchParams.set('context', 'store');
            url.searchParams.set('fresh', 'true');
            url.searchParams.set('isForStore', '1');
            url.searchParams.set('offset', String((pageNumber - 1) * limit));
            url.searchParams.set('limit', String(limit));
            return url.toString();
        },
        async loadPage(pageNumber, context) {
            await this.ensureRubRate(context.signal);
            const data = await fetchJson(this.buildUrl(pageNumber), { signal: context.signal, credentials: 'include' });
            const cards = this.findItems(data).map(item => this.makeCard(item, data?.counts || {})).filter(Boolean);
            return { page: pageNumber, cards };
        }
    };

    /*************************************************************************
     * Adapter: Waxpeer
     *************************************************************************/

    const WaxpeerAdapter = {
        id: 'waxpeer',
        reloadInitialPage: true,
        maxSiteWorkers: 1,
        pageLimit: 70,
        cardTemplate: null,
        gridElement: null,
        nativeGridElement: null,
        nativeGridObserver: null,
        nativeGridObserverTarget: null,
        portalResizeObserver: null,
        portalSyncTimer: null,
        activeGame: 'csgo',
        nextCursor: null,
        hasMore: true,
        rubPerUsd: NaN,
        currencyFetchedAt: 0,
        currencyPromise: null,
        readinessKey: '',
        readinessStartedAt: 0,
        gameByAppId: {
            730: 'csgo',
            252490: 'rust',
            440: 'tf2',
            570: 'dota2'
        },
        appIdByGame: {
            csgo: 730,
            rust: 252490,
            tf2: 440,
            dota2: 570
        },
        matches() {
            if (!['waxpeer.com', 'www.waxpeer.com'].includes(window.location.hostname)) return false;
            if (this.gridElement?.isConnected && this.gridElement.id === 'profit-helper-waxpeer-grid') return true;

            const cards = Array.from(document.querySelectorAll('.catalog__list:not(#profit-helper-waxpeer-grid) > .item-card'));
            const firstImage = cards[0]?.querySelector('a.thumb-link img')?.getAttribute('src') || '';
            if (!cards.length || !firstImage) return false;

            const readinessKey = `${window.location.pathname}|${cards.length}|${firstImage}`;
            if (readinessKey !== this.readinessKey) {
                this.readinessKey = readinessKey;
                this.readinessStartedAt = Date.now();
                return false;
            }
            return Date.now() - this.readinessStartedAt >= 1200;
        },
        getStyles() {
            return `
                .waxpeer-generated-card {
                    position: relative !important;
                    overflow: visible !important;
                }
                .waxpeer-generated-card .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                    top: 8px !important;
                    left: 8px !important;
                    right: 8px !important;
                    width: auto !important;
                    margin: 0 !important;
                }
            `;
        },
        getGrid(root = document) {
            if (root === document && this.gridElement?.isConnected) return this.gridElement;
            const grid = root.querySelector?.('.catalog__list:not(#profit-helper-waxpeer-grid)') || null;
            if (root === document && grid) this.gridElement = grid;
            return grid;
        },
        getCards(root = document) {
            const grid = this.getGrid(root);
            return Array.from(grid?.children || [])
                .filter(card => card.classList?.contains('item-card'));
        },
        ownsCard(card) {
            return Boolean(card?.classList?.contains('item-card') && card.closest('.catalog__list'));
        },
        detectGameFromCards(cards = this.getCards()) {
            for (const card of cards) {
                const imageUrls = Array.from(card.querySelectorAll('img'), image => image.currentSrc || image.getAttribute('src') || '');
                for (const imageUrl of imageUrls) {
                    const appId = parseInt(imageUrl.match(/\/economy\/image\/class\/(\d+)\//i)?.[1], 10);
                    if (this.gameByAppId[appId]) return this.gameByAppId[appId];
                }
            }
            return this.activeGame || 'csgo';
        },
        detectGameFromPath() {
            const segments = window.location.pathname.split('/').filter(Boolean);
            const routeGame = segments.find(segment => this.appIdByGame[segment]);
            return routeGame || 'csgo';
        },
        getAppId() {
            return this.appIdByGame[this.activeGame] || 730;
        },
        prepareReloadGrid(grid) {
            const nativeGrid = document.querySelector('.catalog__list:not(#profit-helper-waxpeer-grid)');
            const cards = nativeGrid
                ? Array.from(nativeGrid.children).filter(card => card.classList?.contains('item-card'))
                : this.getCards();
            this.activeGame = this.detectGameFromPath() || this.detectGameFromCards(cards);
            const nativeTemplate = cards.find(card => !card.classList.contains('waxpeer-generated-card'));
            if (nativeTemplate) {
                this.cardTemplate = nativeTemplate.cloneNode(true);
                this.resetGeneratedCard(this.cardTemplate);
            }

            if (grid.id !== 'profit-helper-waxpeer-grid') {
                document.getElementById('profit-helper-waxpeer-grid')?.remove();
                const generatedGrid = grid.cloneNode(false);
                generatedGrid.id = 'profit-helper-waxpeer-grid';
                generatedGrid.style.cssText = 'position:absolute;z-index:20;margin:0;';
                document.body.appendChild(generatedGrid);
                this.nativeGridElement = grid;
                this.gridElement = generatedGrid;
                this.startPortalSync();
                grid = generatedGrid;
            }
            this.gridElement = grid;
            this.nextCursor = null;
            this.hasMore = true;
            return grid;
        },
        startPortalSync() {
            this.portalResizeObserver?.disconnect();
            if (this.portalSyncTimer) clearInterval(this.portalSyncTimer);

            const sync = () => {
                const helperGrid = this.gridElement;
                if (!helperGrid?.isConnected) return;

                const nativeGrid = this.nativeGridElement?.isConnected
                    ? this.nativeGridElement
                    : document.querySelector('.catalog__list:not(#profit-helper-waxpeer-grid)');
                if (!nativeGrid) return;
                this.nativeGridElement = nativeGrid;
                nativeGrid.style.visibility = 'hidden';

                const rect = nativeGrid.getBoundingClientRect();
                const nativeStyle = window.getComputedStyle(nativeGrid);
                helperGrid.style.left = `${rect.left + window.scrollX}px`;
                helperGrid.style.top = `${rect.top + window.scrollY}px`;
                helperGrid.style.width = `${rect.width}px`;
                helperGrid.style.display = nativeStyle.display;
                helperGrid.style.gridTemplateColumns = nativeStyle.gridTemplateColumns;
                helperGrid.style.columnGap = nativeStyle.columnGap;
                helperGrid.style.rowGap = nativeStyle.rowGap;
                nativeGrid.style.minHeight = `${Math.max(rect.height, helperGrid.scrollHeight)}px`;
                this.clearNativeGrid(nativeGrid);
            };

            this.portalResizeObserver = new ResizeObserver(sync);
            this.portalResizeObserver.observe(this.gridElement);
            this.portalSyncTimer = setInterval(sync, 500);
            sync();
        },
        clearNativeGrid(nativeGrid) {
            if (this.nativeGridObserverTarget !== nativeGrid) {
                this.nativeGridObserver?.disconnect();
                const observer = new MutationObserver(() => {
                    if (nativeGrid.childElementCount) nativeGrid.replaceChildren();
                });
                observer.observe(nativeGrid, { childList: true });
                this.nativeGridObserver = observer;
                this.nativeGridObserverTarget = nativeGrid;
            }
            if (nativeGrid.childElementCount) nativeGrid.replaceChildren();
        },
        resetGeneratedCard(card) {
            card.classList.add('waxpeer-generated-card');
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
            [
                ATTRIBUTE.processed,
                ATTRIBUTE.filtered,
                ATTRIBUTE.profit,
                ATTRIBUTE.profitPercent,
                ATTRIBUTE.result,
                ATTRIBUTE.queued,
                ATTRIBUTE.marketHashName,
                ATTRIBUTE.price,
                ATTRIBUTE.discount,
                'data-waxpeer-item-id'
            ].forEach(attribute => card.removeAttribute(attribute));
        },
        getName(card) {
            return normalizeText(card.getAttribute(ATTRIBUTE.marketHashName)
                || card.querySelector(':scope > a.sr-only')?.textContent
                || card.querySelector('a.name')?.textContent);
        },
        getSteamMarketHashName(card) {
            return normalizeText(card.getAttribute(ATTRIBUTE.marketHashName));
        },
        getPrice(card) {
            return parsePrice(card.getAttribute(ATTRIBUTE.price));
        },
        getDiscount(card) {
            return parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount));
        },
        async getRubPerUsd(signal) {
            if (isValidPrice(this.rubPerUsd) && Date.now() - this.currencyFetchedAt < 5 * 60 * 1000) {
                return this.rubPerUsd;
            }
            if (!this.currencyPromise) {
                this.currencyPromise = (async () => {
                    const data = await fetchJson(new URL('/api/currencies', window.location.origin).toString(), {
                        signal,
                        credentials: 'include'
                    });
                    const currencies = Array.isArray(data?.data) ? data.data : [];
                    const usd = Number(currencies.find(currency => String(currency.type).toUpperCase() === 'USD')?.price);
                    const rub = Number(currencies.find(currency => String(currency.type).toUpperCase() === 'RUB')?.price);
                    const rate = rub / usd;
                    if (!isValidPrice(rate)) throw new Error('Курс USD/RUB Waxpeer не найден');
                    this.rubPerUsd = rate;
                    this.currencyFetchedAt = Date.now();
                    return rate;
                })().finally(() => {
                    this.currencyPromise = null;
                });
            }
            return this.currencyPromise;
        },
        getItemPriceRub(item) {
            const milliUsd = Number(item?.price);
            const price = (milliUsd / 1000) * this.rubPerUsd;
            return isValidPrice(price) ? Math.round(price * 100) / 100 : NaN;
        },
        getItemDiscount(item) {
            const salePrice = Number(item?.price);
            const referencePrice = Number(item?.steam_price?.average);
            if (!isValidPrice(salePrice) || !isValidPrice(referencePrice) || salePrice >= referencePrice) return null;
            return Math.floor(((referencePrice - salePrice) / referencePrice) * 100);
        },
        formatUsd(milliUsd) {
            const value = Number(milliUsd) / 1000;
            if (!isValidPrice(value)) return '';
            return `$${value.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })}`;
        },
        slugifyName(name) {
            return String(name || '')
                .normalize('NFKD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[\u2018\u2019']/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
        },
        getItemHref(item) {
            const gamePrefix = this.activeGame === 'csgo' ? '' : `/${this.activeGame}`;
            return `${gamePrefix}/${this.slugifyName(item.name)}/item/${encodeURIComponent(item.item_id)}`;
        },
        getImageUrl(item) {
            const source = normalizeText(item?.image);
            if (!source) return '';
            if (source.startsWith('https://imageproxy.waxpeer.com/')) return source;
            return `https://imageproxy.waxpeer.com/insecure/rs:fit:300:170:0/g:nowe/f:webp/plain/${source}`;
        },
        splitItemName(item) {
            const name = normalizeText(item.name);
            const separatorIndex = name.indexOf('|');
            if (separatorIndex >= 0) {
                return {
                    model: normalizeText(name.slice(0, separatorIndex)),
                    market: normalizeText(item.market_name || name.slice(separatorIndex + 1).replace(/\s+\([^)]*\)$/, ''))
                };
            }
            return {
                model: normalizeText(item.brand || item.category),
                market: normalizeText(item.market_name || name)
            };
        },
        makeCard(item) {
            const marketHashName = normalizeText(item?.name);
            const sitePrice = this.getItemPriceRub(item);
            if (!this.cardTemplate || !marketHashName || !item?.item_id || !isValidPrice(sitePrice)) return null;

            const card = this.cardTemplate.cloneNode(true);
            this.resetGeneratedCard(card);
            const discount = this.getItemDiscount(item);
            const itemHref = this.getItemHref(item);
            const nameParts = this.splitItemName(item);
            card.setAttribute(ATTRIBUTE.marketHashName, marketHashName);
            card.setAttribute(ATTRIBUTE.price, String(sitePrice));
            card.setAttribute('data-waxpeer-item-id', String(item.item_id));
            if (discount !== null) card.setAttribute(ATTRIBUTE.discount, `-${discount}%`);

            const itemLinks = card.querySelectorAll(':scope > a.sr-only, a.thumb-link, a.name');
            itemLinks.forEach(link => { link.href = itemHref; });
            const fullNameLink = card.querySelector(':scope > a.sr-only');
            if (fullNameLink) fullNameLink.textContent = marketHashName;

            const rarityColor = normalizeText(item.steam_price?.rarity_color);
            const thumbBackground = card.querySelector('.thumb-bg');
            if (thumbBackground && rarityColor) thumbBackground.style.color = rarityColor;
            const imageUrl = this.getImageUrl(item);
            const itemImages = Array.from(card.querySelectorAll('a.thumb-link img'));
            const desktopImage = itemImages.find(image => !image.classList.contains('lg:hidden'));
            const mobileImage = itemImages.find(image => image.classList.contains('lg:hidden'));
            const retainedImages = new Set([desktopImage, mobileImage].filter(Boolean));
            itemImages.forEach(image => {
                if (!retainedImages.has(image)) {
                    image.parentElement?.remove();
                    return;
                }
                image.src = imageUrl;
                image.removeAttribute('srcset');
                image.alt = marketHashName;
                image.loading = 'lazy';
                image.decoding = 'async';
            });

            const modelElement = card.querySelector('.name_model span');
            if (modelElement) modelElement.textContent = nameParts.model;
            const marketElement = card.querySelector('.name_market');
            if (marketElement) marketElement.textContent = nameParts.market;

            const priceRow = Array.from(card.querySelectorAll('div'))
                .find(element => Array.from(element.children).some(child => child.matches?.('div.inline-flex'))
                    && Boolean(element.querySelector(':scope > div span.font-medium')));
            const discountElement = Array.from(priceRow?.children || [])
                .find(element => element.matches?.('div.inline-flex'));
            const priceElement = priceRow?.querySelector(':scope > div span.font-medium');
            if (priceElement) priceElement.textContent = this.formatUsd(item.price);
            if (discountElement) {
                discountElement.textContent = discount !== null ? `-${discount}%` : '';
                discountElement.style.visibility = discount !== null ? '' : 'hidden';
            }

            const referencePriceElement = card.querySelector(':scope > .absolute span.font-medium');
            if (referencePriceElement) {
                const referencePrice = this.formatUsd(item.steam_price?.average);
                referencePriceElement.textContent = referencePrice;
                referencePriceElement.style.visibility = referencePrice ? '' : 'hidden';
            }

            card.querySelectorAll('.stickers--card').forEach(stickerBlock => stickerBlock.remove());
            const floatBlock = card.querySelector('.float-card');
            if (floatBlock) {
                const floatValue = Number(item.float);
                floatBlock.style.visibility = Number.isFinite(floatValue) ? '' : 'hidden';
                const values = floatBlock.querySelectorAll(':scope > div > span');
                if (values[0]) values[0].textContent = normalizeText(item.exterior);
                if (values[1]) values[1].textContent = Number.isFinite(floatValue) ? floatValue.toFixed(7) : '';
            }

            const buttons = Array.from(card.querySelectorAll('button'));
            const cartButton = buttons.find(button => /add .* to cart/i.test(button.getAttribute('aria-label') || ''));
            if (cartButton) cartButton.style.display = 'none';
            const buyButton = buttons.find(button => /buy now/i.test(normalizeText(button.textContent))) || buttons.at(-1);
            if (buyButton) {
                buyButton.textContent = 'Открыть предмет';
                buyButton.addEventListener('click', () => window.location.assign(itemHref));
            }
            return card;
        },
        getRouteFilters() {
            const localePattern = /^(?:ar|da|de|es|fr|nl|pl|pt|ro|ru|sv|tr|uk|zh)$/i;
            const segments = window.location.pathname.split('/').filter(Boolean);
            if (localePattern.test(segments[0] || '')) segments.shift();

            const brandByRoute = {
                rifles: 'rifle',
                'sniper-rifles': 'sniper rifle',
                knives: 'knife',
                gloves: 'gloves',
                machineguns: 'machinegun',
                smgs: 'smg',
                shotguns: 'shotgun',
                pistols: 'pistol',
                other: 'other'
            };
            const filters = {};
            if (brandByRoute[segments[0]]) filters.brand = brandByRoute[segments[0]];
            if (segments[1]) filters.type = segments[1];
            return filters;
        },
        buildBrowseUrl(cursor = null, context = {}) {
            const url = new URL(`/api/${this.activeGame}/browse`, window.location.origin);
            url.searchParams.set('sort', 'DESC');
            url.searchParams.set('order', 'advised');
            url.searchParams.set('all', '0');
            url.searchParams.set('limit', String(this.pageLimit));
            url.searchParams.set('lang', 'en');

            Object.entries(this.getRouteFilters()).forEach(([key, value]) => url.searchParams.set(key, value));
            const searchParams = context.searchParams || new URLSearchParams(window.location.search);
            searchParams.forEach((value, key) => {
                if (key !== 'cursor') url.searchParams.append(key, value);
            });
            if (cursor) url.searchParams.set('cursor', cursor);
            return url.toString();
        },
        async loadPage(pageNumber, context) {
            if (pageNumber > 1 && (!this.hasMore || !this.nextCursor)) {
                return { page: pageNumber, cards: [] };
            }

            await this.getRubPerUsd(context.signal);
            const cursor = pageNumber > 1 ? this.nextCursor : null;
            const data = await fetchJson(this.buildBrowseUrl(cursor, context), {
                signal: context.signal,
                credentials: 'include'
            });
            if (data?.success !== true || !Array.isArray(data.items)) {
                throw new Error(data?.msg || 'Ошибка API Waxpeer');
            }

            this.hasMore = data.hasMore === true;
            this.nextCursor = normalizeText(data.nextCursor);
            const minDiscount = readNumberInput('discount-input', 0);
            const cards = data.items
                .filter(item => {
                    const discount = this.getItemDiscount(item);
                    return minDiscount <= 0 || (discount !== null && discount >= minDiscount);
                })
                .map(item => this.makeCard(item))
                .filter(Boolean);
            return { page: pageNumber, cards };
        }
    };

    /*************************************************************************
     * Adapter: Moon Market
     *************************************************************************/

    const MoonMarketAdapter = {
        id: 'moon-market',
        reloadInitialPage: true,
        maxSiteWorkers: 4,
        totalPages: null,
        rubPerUsd: NaN,
        offerCache: new Map(),
        matches: () => ['moon.market', 'www.moon.market'].includes(window.location.hostname)
            && /(?:^|\/)shop(?:\/|$)/i.test(window.location.pathname),
        getAppId() {
            const appId = parseInt(new URLSearchParams(window.location.search).get('app_id'), 10);
            return Number.isFinite(appId) && appId > 0 ? appId : detectAppId(730);
        },
        getStyles() {
            return `
                .moon-profit-card {
                    position: relative !important;
                }
                .moon-profit-card > .block {
                    position: relative !important;
                    overflow: visible !important;
                }
                .moon-profit-card .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                    top: auto !important;
                    bottom: 8px !important;
                    left: 8px !important;
                    right: 8px !important;
                    display: flex !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                }
            `;
        },
        getGrid(root = document) {
            return root.querySelector?.('.shop .products > ul, .products > ul') || null;
        },
        createGrid() {
            const products = document.querySelector('.shop .products, .products');
            if (!products) return null;

            let grid = products.querySelector(':scope > ul');
            if (!grid) {
                grid = document.createElement('ul');
                products.replaceChildren(grid);
            }
            return grid;
        },
        getCards(root = document) {
            const grid = this.getGrid(root);
            return Array.from(grid?.querySelectorAll(':scope > li') || [])
                .filter(card => card.querySelector('.item-name') || card.hasAttribute(ATTRIBUTE.marketHashName));
        },
        ownsCard(card) {
            return Boolean(card?.matches?.('li')
                && (card.classList.contains('moon-profit-card') || card.closest('.shop .products, .products')));
        },
        getBadgeContainer(card) {
            return card.querySelector(':scope > .block') || card;
        },
        getName(card) {
            return normalizeText(card.getAttribute(ATTRIBUTE.marketHashName)
                || card.querySelector('.item-name')?.textContent);
        },
        getSteamMarketHashName(card) {
            return this.getName(card);
        },
        getPrice(card) {
            const storedPrice = parsePrice(card.getAttribute(ATTRIBUTE.price));
            if (isValidPrice(storedPrice)) return storedPrice;

            return parsePrice(card.querySelector('[data-profit-helper-moon-price]')?.textContent
                || card.querySelector('.price')?.textContent);
        },
        getDiscount(card) {
            return parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount)
                || card.querySelector('.discount')?.textContent);
        },
        parseCurrencyRate(value) {
            const match = String(value || '').match(/^\s*(\d+(?:[.,]\d+)?)/);
            return parsePrice(match?.[1]);
        },
        readRubPerUsd() {
            const runtimeValue = window.config_js?.rub;
            const runtimeRate = this.parseCurrencyRate(runtimeValue);
            if (isValidPrice(runtimeRate)) return runtimeRate;

            const scriptsText = Array.from(document.scripts)
                .map(script => script.textContent || '')
                .find(text => /['"]rub['"]\s*:\s*['"][^'"]+/i.test(text)) || '';
            const match = scriptsText.match(/['"]rub['"]\s*:\s*['"]([^'"]+)/i);
            return this.parseCurrencyRate(match?.[1]);
        },
        async ensureRubPerUsd(signal) {
            const runtimeRate = this.readRubPerUsd();
            if (isValidPrice(runtimeRate)) {
                this.rubPerUsd = runtimeRate;
                return runtimeRate;
            }
            if (isValidPrice(this.rubPerUsd)) return this.rubPerUsd;

            const doc = await fetchDocument(window.location.href, { signal, credentials: 'include' });
            const scriptsText = Array.from(doc.scripts).map(script => script.textContent || '').join('\n');
            const match = scriptsText.match(/['"]rub['"]\s*:\s*['"]([^'"]+)/i);
            const rate = this.parseCurrencyRate(match?.[1]);
            if (!isValidPrice(rate)) throw new Error('курс USD/RUB Moon Market не найден');

            this.rubPerUsd = rate;
            return rate;
        },
        getItemPriceRub(item) {
            const usdPrice = Number(item?.price);
            if (!isValidPrice(usdPrice) || !isValidPrice(this.rubPerUsd)) return NaN;
            return Math.round(usdPrice * this.rubPerUsd * 100) / 100;
        },
        getItemDiscount(item) {
            const sitePrice = Number(item?.price);
            const steamReferencePrice = Number(item?.price_steam);
            if (!isValidPrice(sitePrice) || !isValidPrice(steamReferencePrice) || sitePrice >= steamReferencePrice) return null;
            return Math.round(((steamReferencePrice - sitePrice) / steamReferencePrice) * 100);
        },
        needsPriceValidation(item) {
            const discount = this.getItemDiscount(item);
            return discount !== null && discount >= CONFIG.moonPriceValidationDiscountPercent;
        },
        pruneOfferCache() {
            const now = Date.now();
            for (const [key, value] of this.offerCache.entries()) {
                if (!value?.expiresAt || value.expiresAt <= now) this.offerCache.delete(key);
            }
            while (this.offerCache.size > CONFIG.maxMoonOfferCacheEntries) {
                this.offerCache.delete(this.offerCache.keys().next().value);
            }
        },
        buildOffersUrl(item) {
            const url = new URL(window.location.pathname, window.location.origin);
            url.searchParams.set('page_load', 'ajax');
            url.searchParams.set('url', '/ajax/market2.ajax');
            url.searchParams.set('action', 'item');
            url.searchParams.set('mm_name', normalizeText(item?.name));
            url.searchParams.set('sort', 'price_asc');
            url.searchParams.set('appid', String(item?.app_id || this.getAppId()));
            return url.toString();
        },
        async getCheapestOffer(item, signal) {
            this.pruneOfferCache();
            const cacheKey = `${item?.app_id || this.getAppId()}:${normalizeText(item?.name)}`;
            let cached = this.offerCache.get(cacheKey);
            if (!cached) {
                const promise = fetchJson(this.buildOffersUrl(item), {
                    signal,
                    credentials: 'include'
                }).then(data => {
                    if (data?.error || !Array.isArray(data?.items)) {
                        throw new Error(data?.error || 'офферы Moon Market не найдены');
                    }
                    const marketHashName = normalizeText(item?.name);
                    const offers = data.items
                        .filter(offer => normalizeText(offer?.name) === marketHashName && isValidPrice(Number(offer?.price)))
                        .sort((a, b) => Number(a.price) - Number(b.price));
                    if (!offers.length) throw new Error('доступные офферы Moon Market не найдены');
                    return offers[0];
                });
                cached = {
                    expiresAt: Date.now() + CONFIG.moonOfferCacheTtlMs,
                    promise
                };
                this.offerCache.set(cacheKey, cached);
                promise.catch(() => this.offerCache.delete(cacheKey));
                this.pruneOfferCache();
            }
            return cached.promise;
        },
        async resolveItemPrice(item, signal) {
            if (!this.needsPriceValidation(item)) return item;

            try {
                const offer = await this.getCheapestOffer(item, signal);
                const catalogPrice = Number(item.price);
                const actualPrice = Number(offer.price);
                if (actualPrice !== catalogPrice) {
                    logWork('WARN', 'Цена Moon Market уточнена по офферам', {
                        item: item.name,
                        catalogPrice: formatCurrency(catalogPrice * this.rubPerUsd),
                        actualPrice: formatCurrency(actualPrice * this.rubPerUsd)
                    });
                }
                return {
                    ...item,
                    ...offer,
                    sell_count: item.sell_count,
                    sell_count_exact: item.sell_count_exact
                };
            } catch (error) {
                if (signal?.aborted) throw error;
                logWork('ERROR', 'Не удалось уточнить цену Moon Market', {
                    item: item?.name,
                    error: error.message || String(error)
                });
                return null;
            }
        },
        async resolveItemPrices(items, signal) {
            const resolved = new Array(items.length);
            let nextIndex = 0;
            const worker = async () => {
                while (nextIndex < items.length) {
                    const index = nextIndex++;
                    resolved[index] = await this.resolveItemPrice(items[index], signal);
                }
            };
            const workersCount = Math.min(4, items.length);
            await Promise.all(Array.from({ length: workersCount }, () => worker()));
            return resolved.filter(Boolean);
        },
        parseItemFilters(item) {
            if (item?.filters && typeof item.filters === 'object') return item.filters;
            try {
                return JSON.parse(item?.filters || '{}');
            } catch (_) {
                return {};
            }
        },
        getProvider(item) {
            if (item?.provider === 2 || item?.provider === 'igxe') return 'igxe';
            if (item?.provider === 3 || item?.provider === 'ecosteam') return 'ecosteam';
            if (item?.provider === 4) return '4';
            return 'sales_panel';
        },
        getItemHref(item) {
            const locale = window.location.pathname.match(/^\/([a-z]{2})(?:\/|$)/i)?.[1] || 'ru';
            const url = new URL(`/${locale}/shop/`, window.location.origin);
            url.searchParams.set('item_name', normalizeText(item?.name));
            url.searchParams.set('app_id', String(item?.app_id || this.getAppId()));
            return url.toString();
        },
        resetCard(card) {
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
            [
                ATTRIBUTE.processed,
                ATTRIBUTE.filtered,
                ATTRIBUTE.profit,
                ATTRIBUTE.profitPercent,
                ATTRIBUTE.result,
                ATTRIBUTE.queued
            ].forEach(attribute => card.removeAttribute(attribute));
        },
        makeCard(item) {
            const marketHashName = normalizeText(item?.name);
            const sitePrice = this.getItemPriceRub(item);
            if (!marketHashName || !isValidPrice(sitePrice)) return null;

            const filters = this.parseItemFilters(item);
            const discount = this.getItemDiscount(item);
            const itemHref = this.getItemHref(item);
            const provider = this.getProvider(item);
            const holdDays = Number(item?.hold);
            const transferText = holdDays > 0
                ? `${holdDays} дн.`
                : provider === 'sales_panel' ? 'Мгновенно' : 'до 12 ч.';

            const card = document.createElement('li');
            card.className = 'moon-profit-card';
            card.setAttribute(ATTRIBUTE.marketHashName, marketHashName);
            card.setAttribute(ATTRIBUTE.price, String(sitePrice));
            if (discount !== null) card.setAttribute(ATTRIBUTE.discount, `-${discount}%`);
            this.resetCard(card);
            card.innerHTML = `
                <div class="block">
                    <div class="add-to-btn"><button type="button" class="js-add-to-basket">В корзину</button></div>
                    <div class="head-i">
                        <div class="price" data-profit-helper-moon-price="true">${escapeHtml(formatCurrency(sitePrice))}</div>
                        ${discount !== null ? `<div class="discount">-${discount}%</div>` : ''}
                    </div>
                    <div class="img"><img src="${escapeHtml(item?.image || '')}" alt="${escapeHtml(marketHashName)}" loading="lazy"></div>
                    <div class="float-extra">
                        <div class="l">x${Math.max(1, Number(item?.sell_count) || 1)}${item?.sell_count_exact === false ? '+' : ''}</div>
                        <div class="r ${holdDays > 0 ? 'locked' : 'instantly'}">${escapeHtml(transferText)}</div>
                    </div>
                    <div class="inner red"></div>
                    <div class="bottom-line red"></div>
                </div>
                <a class="profit-helper-moon-item-link" href="${escapeHtml(itemHref)}" style="text-decoration:none">
                    <div class="item-name">${escapeHtml(marketHashName)}</div>
                    <div class="item-type">${escapeHtml(filters.type || '')}</div>
                </a>
            `;

            const button = card.querySelector('.js-add-to-basket');
            button.dataset.name = marketHashName;
            button.dataset.id = String(item?.item_id ?? item?.id ?? '');
            button.dataset.price = String(item.price);
            button.dataset.count = String(Math.max(1, Number(item?.sell_count) || 1));
            button.dataset.provider = provider;
            button.dataset.unitPrice = String(item?.price_api ?? '');
            button.dataset.priceBuy = String(item?.price_buy ?? '');
            button.dataset.priceAuto = String(item?.price_auto ?? '');

            return card;
        },
        prepareReloadGrid(grid) {
            this.totalPages = null;
            grid.replaceChildren();
            document.querySelector('.shop .pagination, .pagination')?.replaceChildren();
            return grid;
        },
        buildBrowseUrl(pageNumber, context = {}) {
            const url = new URL(window.location.pathname, window.location.origin);
            const sourceParams = context.searchParams || new URLSearchParams(window.location.search);
            const supportedParams = [
                'filters', 'search', 'sort', 'float_from', 'float_to', 'price_from', 'price_to'
            ];

            url.searchParams.set('page_load', 'ajax');
            url.searchParams.set('url', '/ajax/market2.ajax');
            url.searchParams.set('currency', 'rub');
            url.searchParams.set('lang', 'en');
            url.searchParams.set('app_id', String(this.getAppId()));
            supportedParams.forEach(key => {
                const value = sourceParams.get(key);
                if (value !== null) url.searchParams.set(key, value);
            });
            if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'price_desc');
            url.searchParams.set('page_id', String(pageNumber));
            return url.toString();
        },
        async loadPage(pageNumber, context) {
            if (this.totalPages !== null && pageNumber > this.totalPages) {
                return { page: pageNumber, cards: [] };
            }

            await this.ensureRubPerUsd(context.signal);
            const data = await fetchJson(this.buildBrowseUrl(pageNumber, context), {
                signal: context.signal,
                credentials: 'include'
            });
            if (data?.error || !Array.isArray(data?.items)) {
                throw new Error(data?.error || 'ошибка API Moon Market');
            }

            const totalPages = Number(data.pagination?.total);
            if (Number.isFinite(totalPages) && totalPages >= 0) this.totalPages = totalPages;
            const resolvedItems = await this.resolveItemPrices(data.items, context.signal);
            const minDiscount = readNumberInput('discount-input', 0);
            const cards = resolvedItems
                .filter(item => {
                    const discount = this.getItemDiscount(item);
                    return minDiscount <= 0 || (discount !== null && discount >= minDiscount);
                })
                .map(item => this.makeCard(item))
                .filter(Boolean);
            return { page: pageNumber, cards };
        }
    };

    /*************************************************************************
     * Adapter: Skinport
     *************************************************************************/

    const SkinportAdapter = {
        id: 'skinport',
        reloadInitialPage: true,
        pageLimit: 50,
        cardTemplate: null,
        gridElement: null,
        marketNamesByClassId: new Map(),
        marketNamesBySlug: new Map(),
        matches: () => ['skinport.com', 'www.skinport.com'].includes(window.location.hostname)
            && /(?:^|\/)market(?:\/|$)/i.test(window.location.pathname),
        getAppId() {
            const pathMatch = window.location.pathname.match(/\/market\/(\d+)/i);
            const pathAppId = parseInt(pathMatch?.[1], 10);
            return Number.isFinite(pathAppId) && pathAppId > 0 ? pathAppId : detectAppId(730);
        },
        getStyles() {
            return `
                .skinport-native-profit-card {
                    position: relative !important;
                }
                .skinport-native-profit-card .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                    top: 10px !important;
                    left: 10px !important;
                    right: 10px !important;
                    width: auto !important;
                    min-height: 0 !important;
                    margin: 0 !important;
                }
            `;
        },
        findNativeGrid(root = document) {
            const links = Array.from(root.querySelectorAll?.('a[href*="/item/"]') || []);
            const candidates = new Map();

            links.forEach(link => {
                for (let node = link.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
                    if (node === document.body || node.tagName === 'MAIN') break;
                    const directCards = Array.from(node.children)
                        .filter(child => child.querySelector?.('a[href*="/item/"]')).length;
                    if (directCards >= 2) {
                        candidates.set(node, Math.max(candidates.get(node) || 0, directCards));
                        break;
                    }
                }
            });

            return Array.from(candidates.entries())
                .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        },
        getGrid(root = document) {
            if (root === document && this.gridElement?.isConnected) return this.gridElement;
            const grid = this.findNativeGrid(root);
            if (root === document && grid) this.gridElement = grid;
            return grid;
        },
        getCards(root = document) {
            const grid = this.getGrid(root);
            if (!grid) return [];
            return Array.from(grid.children)
                .filter(card => card.classList?.contains('skinport-generated-card')
                    || card.matches?.('a[href*="/item/"]')
                    || card.querySelector?.('a[href*="/item/"]'))
                .map(card => {
                    card.classList.add('skinport-native-profit-card');
                    return card;
                });
        },
        ownsCard(card) {
            return Boolean(card?.classList?.contains('skinport-native-profit-card'));
        },
        prepareReloadGrid(grid) {
            const template = this.getCards().find(card => !card.classList.contains('skinport-generated-card'));
            if (template) {
                this.cardTemplate = template.cloneNode(true);
                this.resetGeneratedCard(this.cardTemplate);
            }
            this.gridElement = grid;
            return grid;
        },
        resetGeneratedCard(card) {
            card.classList.add('skinport-native-profit-card', 'skinport-generated-card');
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
            [
                ATTRIBUTE.processed,
                ATTRIBUTE.filtered,
                ATTRIBUTE.profit,
                ATTRIBUTE.profitPercent,
                ATTRIBUTE.result,
                ATTRIBUTE.queued,
                ATTRIBUTE.marketHashName,
                ATTRIBUTE.price,
                ATTRIBUTE.discount,
                'data-skinport-classid',
                'data-skinport-slug'
            ].forEach(attribute => card.removeAttribute(attribute));
            card.style.removeProperty('z-index');
        },
        rememberMarketName(map, key, marketHashName) {
            const normalizedKey = normalizeText(key);
            const normalizedName = normalizeText(marketHashName);
            if (!normalizedKey || !normalizedName) return;

            if (!map.has(normalizedKey)) map.set(normalizedKey, normalizedName);
            else if (map.get(normalizedKey) !== normalizedName) map.set(normalizedKey, null);

            while (map.size > CONFIG.maxSteamCacheEntries) map.delete(map.keys().next().value);
        },
        rememberItems(items) {
            items.forEach(item => {
                const appId = String(item.appid || this.getAppId());
                this.rememberMarketName(this.marketNamesByClassId, `${appId}:${item.classid || ''}`, item.marketHashName);
                this.rememberMarketName(this.marketNamesBySlug, `${appId}:${item.url || ''}`, item.marketHashName);
            });
        },
        getClassId(card) {
            const storedClassId = normalizeText(card.getAttribute('data-skinport-classid'));
            if (storedClassId) return storedClassId;

            const imageUrl = card.querySelector?.('.ItemPreview-itemImage img, img')?.getAttribute('src') || '';
            return imageUrl.match(/\/economy\/image\/class\/\d+\/(\d+)/i)?.[1] || '';
        },
        getSlug(card) {
            const storedSlug = normalizeText(card.getAttribute('data-skinport-slug'));
            if (storedSlug) return storedSlug;

            const href = card.querySelector?.('.ItemPreview-link[href*="/item/"], .ItemPreview-href[href*="/item/"], a[href*="/item/"]')?.getAttribute('href') || '';
            try {
                return decodeURIComponent(new URL(href, window.location.origin).pathname.match(/\/item\/([^/?#]+)/i)?.[1] || '');
            } catch (_) {
                return '';
            }
        },
        getSteamMarketHashName(card) {
            const storedName = normalizeText(card.getAttribute(ATTRIBUTE.marketHashName));
            if (storedName) return storedName;

            const appId = String(this.getAppId());
            const byClassId = this.marketNamesByClassId.get(`${appId}:${this.getClassId(card)}`);
            if (byClassId) return byClassId;
            return this.marketNamesBySlug.get(`${appId}:${this.getSlug(card)}`) || '';
        },
        getName(card) {
            const storedName = normalizeText(card.getAttribute(ATTRIBUTE.marketHashName));
            if (storedName) return storedName;

            const skinportName = normalizeText(card.querySelector('.ItemPreview-href')?.getAttribute('aria-label')
                || card.querySelector('.ItemPreview-itemName')?.textContent);
            if (skinportName) return skinportName;

            const link = card.matches?.('a[href*="/item/"]')
                ? card
                : card.querySelector('a[href*="/item/"]');
            const candidates = [
                card.querySelector?.('[data-market-hash-name]')?.getAttribute('data-market-hash-name'),
                firstText(card, ['[class*="name" i]', '[class*="title" i]']),
                link?.getAttribute('title'),
                link?.getAttribute('aria-label'),
                card.querySelector?.('img[alt]')?.getAttribute('alt')
            ];
            return candidates
                .map(normalizeText)
                .find(value => value.length >= 2 && !/[₽$€£¥%]|руб\.?|USD|EUR/i.test(value)) || '';
        },
        getPrice(card) {
            const storedPrice = parsePrice(card.getAttribute(ATTRIBUTE.price));
            if (isValidPrice(storedPrice)) return storedPrice;

            const skinportPrice = parsePrice(card.querySelector('.ItemPreview-priceValue .Tooltip-link')?.textContent
                || card.querySelector('.ItemPreview-priceValue')?.textContent);
            if (isValidPrice(skinportPrice)) return skinportPrice;

            const elements = Array.from(card.querySelectorAll?.('[class*="price" i], [class*="amount" i], [data-price], span, div') || [])
                .filter(element => !element.closest('.steam-highest-buy-order-link[data-profit-helper-badge="true"]')
                    && !element.querySelector?.('.steam-highest-buy-order-link[data-profit-helper-badge="true"]'));
            const candidates = elements.map(element => {
                const directText = getDirectText(element);
                const fullText = normalizeText(element.textContent);
                const currencyMatch = fullText.match(/\d[\d\s.,]*\s*(?:₽|руб\.?|RUB|[$€£¥₴₸₹])/i);
                const ownText = normalizeText(currencyMatch?.[0]
                    || directText
                    || (element.children.length === 0 ? element.textContent : ''));
                const attributePrice = normalizeText(element.getAttribute('data-price'));
                const text = ownText || attributePrice;
                const marker = `${element.className || ''} ${element.getAttribute('data-testid') || ''} ${text}`;
                const isPriceElement = element.matches('[class*="price" i], [class*="amount" i], [data-price]');
                return {
                    text,
                    value: parsePrice(text),
                    hasCurrency: /[₽$€£¥₴₸₹]|руб\.?|RUB|USD|EUR/i.test(text),
                    isReference: /reference|referent|референт|suggested|recommended|рекомендован/i.test(marker),
                    isPriceElement
                };
            }).filter(candidate => isValidPrice(candidate.value)
                && !/%/.test(candidate.text)
                && (candidate.hasCurrency || candidate.isPriceElement));

            const visiblePrices = candidates
                .filter(candidate => candidate.hasCurrency && !candidate.isReference)
                .map(candidate => candidate.value);
            if (visiblePrices.length) return Math.min(...visiblePrices);

            const fallbackPrices = candidates
                .filter(candidate => !candidate.isReference)
                .map(candidate => candidate.value);
            return fallbackPrices.length ? Math.min(...fallbackPrices) : NaN;
        },
        getDiscount(card) {
            return parseDiscountPercent(card.getAttribute(ATTRIBUTE.discount)
                || card.querySelector('.ItemPreview-discount')?.textContent
                || card.textContent);
        },
        getItemPrice(item) {
            const price = Number(item?.salePrice) / 100;
            return isValidPrice(price) ? price : NaN;
        },
        getItemReferencePrice(item) {
            const price = Number(item?.referencePrice) / 100;
            return isValidPrice(price) ? price : NaN;
        },
        getItemDiscount(item) {
            const salePrice = this.getItemPrice(item);
            const referencePrice = this.getItemReferencePrice(item);
            if (!isValidPrice(salePrice) || !isValidPrice(referencePrice) || salePrice >= referencePrice) return null;
            return Math.round(((referencePrice - salePrice) / referencePrice) * 100);
        },
        formatItemPrice(price, currency = 'RUB') {
            return new Intl.NumberFormat('ru-RU', {
                style: 'currency',
                currency: currency || 'RUB',
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            }).format(price);
        },
        getItemHref(slug) {
            const templateHref = this.cardTemplate?.querySelector('.ItemPreview-link[href*="/item/"], .ItemPreview-href[href*="/item/"]')?.getAttribute('href') || '';
            if (templateHref) return templateHref.replace(/(\/item\/)[^/?#]+/i, `$1${encodeURIComponent(slug)}`);

            const segments = window.location.pathname.split('/').filter(Boolean);
            const marketIndex = segments.indexOf('market');
            const prefix = marketIndex >= 0 ? segments.slice(0, marketIndex).join('/') : '';
            return `/${prefix ? `${prefix}/` : ''}item/${encodeURIComponent(slug)}`;
        },
        makeCard(item) {
            const marketHashName = normalizeText(item?.marketHashName);
            const slug = normalizeText(item?.url);
            const price = this.getItemPrice(item);
            if (!this.cardTemplate || !marketHashName || !slug || !isValidPrice(price)) return null;

            const card = this.cardTemplate.cloneNode(true);
            this.resetGeneratedCard(card);

            const discount = this.getItemDiscount(item);
            const displayName = normalizeText(item.name || item.marketName || marketHashName);
            const itemHref = this.getItemHref(slug);
            card.setAttribute(ATTRIBUTE.marketHashName, marketHashName);
            card.setAttribute(ATTRIBUTE.price, String(price));
            card.setAttribute('data-skinport-classid', normalizeText(item.classid));
            card.setAttribute('data-skinport-slug', slug);
            if (discount !== null) card.setAttribute(ATTRIBUTE.discount, `-${discount}%`);

            const hrefLink = card.querySelector('.ItemPreview-href');
            if (hrefLink) {
                hrefLink.href = itemHref;
                hrefLink.textContent = displayName;
                hrefLink.setAttribute('aria-label', displayName);
            }
            card.querySelectorAll('.ItemPreview-link').forEach(link => { link.href = itemHref; });

            const image = card.querySelector('.ItemPreview-itemImage img');
            if (image) {
                image.src = item.image
                    ? `https://community.steamstatic.com/economy/image/${String(item.image).replace(/^\/+/, '')}/256x128`
                    : `https://community.steamstatic.com/economy/image/class/${item.appid || this.getAppId()}/${item.classid}/256x128`;
                image.removeAttribute('srcset');
                image.alt = displayName;
            }

            const priceElement = card.querySelector('.ItemPreview-priceValue .Tooltip-link');
            if (priceElement) priceElement.textContent = this.formatItemPrice(price, item.currency);

            const oldPriceElement = card.querySelector('.ItemPreview-oldPrice');
            const referencePrice = this.getItemReferencePrice(item);
            if (oldPriceElement) {
                oldPriceElement.textContent = isValidPrice(referencePrice)
                    ? `Референтная цена ${this.formatItemPrice(referencePrice, item.currency)}`
                    : '';
            }

            const discountElement = card.querySelector('.ItemPreview-discount');
            if (discountElement) {
                discountElement.style.display = discount !== null ? '' : 'none';
                const valueElement = discountElement.querySelector('span') || discountElement;
                valueElement.textContent = discount !== null ? `− ${discount}%` : '';
            }

            const titleElement = card.querySelector('.ItemPreview-itemTitle');
            if (titleElement) {
                titleElement.textContent = normalizeText(item.title || item.category);
                if (item.color) titleElement.style.color = item.color;
            }
            const nameElement = card.querySelector('.ItemPreview-itemName');
            if (nameElement) nameElement.textContent = displayName;
            const textElement = card.querySelector('.ItemPreview-itemText');
            if (textElement) textElement.textContent = normalizeText(item.text || item.type);

            const mainAction = card.querySelector('.ItemPreview-mainAction');
            if (mainAction) {
                mainAction.textContent = 'Открыть предмет';
                mainAction.addEventListener('click', () => window.location.assign(itemHref));
            }
            card.querySelectorAll('.ItemPreview-sideAction').forEach(button => { button.style.display = 'none'; });
            return card;
        },
        buildBrowseUrl(pageNumber, context = {}) {
            const url = new URL(`/api/browse/${this.getAppId()}`, window.location.origin);
            const searchParams = context.searchParams || new URLSearchParams(window.location.search);
            searchParams.forEach((value, key) => {
                if (key !== 'skip') url.searchParams.append(key, value);
            });
            const skip = Math.max(0, pageNumber - 1);
            if (skip > 0) url.searchParams.set('skip', String(skip));
            return url.toString();
        },
        async loadPage(pageNumber, context) {
            const data = await fetchJson(this.buildBrowseUrl(pageNumber, context), {
                signal: context.signal,
                credentials: 'include'
            });
            const items = Array.isArray(data?.items) ? data.items : [];
            this.rememberItems(items);

            const minDiscount = readNumberInput('discount-input', 0);
            const cards = items
                .filter(item => {
                    const discount = this.getItemDiscount(item);
                    return minDiscount <= 0 || (discount !== null && discount >= minDiscount);
                })
                .map(item => this.makeCard(item))
                .filter(Boolean);
            return { page: pageNumber, cards, itemsCount: items.length };
        }
    };

    /*************************************************************************
     * Adapter: Steam-Trader
     *************************************************************************/

    const SteamTraderAdapter = {
        id: 'steam-trader',
        matches: () => ['steam-trader.net', 'www.steam-trader.net'].includes(window.location.hostname),
        getAppId: () => detectAppId(730),
        getGrid: (root = document) => root.querySelector('section[class*="skinsGrid"], [class*="skinsGrid"]'),
        getCards(root = document) {
            const grid = this.getGrid(root);
            if (grid) return Array.from(grid.children).filter(card => this.isCardRoot(card, grid));

            return Array.from(root.querySelectorAll('section[class*="skinsGrid"] > *, [class*="skinsGrid"] > *'))
                .filter(card => this.isCardRoot(card, card.parentElement));
        },
        isCardRoot(card, grid = this.getGrid()) {
            return Boolean(card instanceof Element
                && card.parentElement === grid
                && !card.className?.includes?.('purchaseCard')
                && this.getPrice(card)
                && this.getName(card));
        },
        ownsCard(card) {
            return this.isCardRoot(card);
        },
        getAttributeName(card) {
            const attributes = [
                ATTRIBUTE.marketHashName,
                'data-market-name',
                'data-market_hash_name',
                'data-market-hash',
                'data-hash-name',
                'data-item-name',
                'data-name',
                'data-title'
            ];
            const elements = [card, ...Array.from(card.querySelectorAll('[data-market-hash-name], [data-market-name], [data-market_hash_name], [data-market-hash], [data-hash-name], [data-item-name], [data-name], [data-title]'))];

            for (const element of elements) {
                for (const attribute of attributes) {
                    const value = normalizeText(element.getAttribute?.(attribute));
                    if (value && !parsePrice(value)) return value;
                }
            }

            return '';
        },
        getHrefName(card) {
            const hrefs = [
                card.getAttribute?.('href') || '',
                ...Array.from(card.querySelectorAll('a[href]'), link => link.getAttribute('href') || '')
            ];

            for (const href of hrefs) {
                if (!href) continue;

                let pathname = href;
                try {
                    pathname = new URL(href, window.location.origin).pathname;
                } catch (e) {
                    pathname = href.split('?')[0].split('#')[0];
                }

                // Steam-Trader keeps the canonical Steam market hash name in item route URLs.
                const match = pathname.match(/(?:^|\/)(?:cs2|csgo|dota2|tf2)\/(.+)$/i);
                if (!match) continue;

                try {
                    return normalizeText(decodeURIComponent(match[1]));
                } catch (e) {
                    return normalizeText(match[1]);
                }
            }

            return '';
        },
        getName(card) {
            return normalizeText(this.getHrefName(card)
                || this.getAttributeName(card)
                || firstText(card, ['[class*="name" i]', '[class*="title" i]']));
        },
        getPrice(card) {
            return parsePrice(firstText(card, ['[class*="price" i]', '[class*="cost" i]']));
        },
        getDiscount(card) {
            return parseDiscountPercent(card.textContent);
        },
        async loadPage(pageNumber, context) {
            const url = new URL(context.baseUrl);
            context.searchParams.forEach((value, key) => url.searchParams.set(key, value));
            url.searchParams.set('page', String(pageNumber));

            const doc = await fetchDocument(url.toString(), { signal: context.signal });
            return { page: pageNumber, cards: this.getCards(doc).map(card => document.importNode(card, true)) };
        }
    };

    /*************************************************************************
     * Adapter: Keys Store
     *************************************************************************/

    const KeysStoreAdapter = {
        id: 'keys-store',
        matches: () => ['keys-store.com', 'www.keys-store.com'].includes(window.location.hostname)
            && window.location.pathname.includes('/skins/'),
        getAppId: () => detectAppId(440),
        getStyles() {
            return `
                .keys-store-market-card {
                    position: relative !important;
                    overflow: hidden !important;
                }
                .keys-store-market-card .steam-highest-buy-order-link[data-profit-helper-badge="true"] {
                    top: 32px !important;
                    left: 12px !important;
                    right: 12px !important;
                    width: auto !important;
                    max-width: calc(100% - 24px) !important;
                    margin: 0 !important;
                }
            `;
        },
        getGrid(root = document) {
            const containers = Array.from(root.querySelectorAll([
                '[class*="skins" i]',
                '[class*="catalog" i]',
                '[class*="products" i]',
                '[class*="items" i]',
                '[class*="grid" i]',
                '[class*="list" i]',
                'main'
            ].join(', ')));
            const directGrid = containers
                .map(container => ({ container, cardsCount: this.countDirectCards(container) }))
                .filter(candidate => candidate.cardsCount >= 2)
                .sort((a, b) => b.cardsCount - a.cardsCount)[0];

            if (directGrid) return directGrid.container;

            return containers
                .filter(container => this.getItemLinks(container).length >= 2)
                .sort((a, b) => this.getElementDepth(b) - this.getElementDepth(a))[0]
                || null;
        },
        getCards(root = document) {
            const grid = this.getGrid(root);
            const cardRoot = grid || root;
            const seen = new Set();
            const cards = [];

            this.getItemLinks(cardRoot).forEach(link => {
                const card = this.getCardFromLink(link, cardRoot);
                if (!card || seen.has(card)) return;
                if (!this.isAvailableCard(card) || !this.getPrice(card) || !this.getName(card)) {
                    card.remove();
                    return;
                }

                card.classList.add('keys-store-market-card');
                seen.add(card);
                cards.push(card);
            });

            return cards;
        },
        ownsCard(card) {
            return Boolean(card?.classList?.contains('keys-store-market-card')
                || (this.getItemLinks(card).length > 0 && this.isAvailableCard(card) && this.getName(card) && this.getPrice(card)));
        },
        isAvailableCard(card) {
            const text = normalizeText(card?.innerText || card?.textContent || '').toLowerCase();
            if (!text) return false;
            if (text.includes('недоступно')) return false;

            return text.includes('добавить в корзину');
        },
        getItemLinks(root) {
            if (!root?.querySelectorAll) return [];

            const links = [];
            if (root.matches?.('a[href*="/skins/"]')) links.push(root);
            links.push(...root.querySelectorAll('a[href*="/skins/"]'));

            return links.filter(link => this.getNameFromHref(link.getAttribute('href')));
        },
        getNameFromHref(href) {
            if (!href) return '';

            let pathname = href;
            try {
                pathname = new URL(href, window.location.origin).pathname;
            } catch (e) {
                pathname = href.split('?')[0].split('#')[0];
            }

            const match = pathname.match(/(?:^|\/)skins\/([^/?#]+)\/?$/i);
            if (!match || /^(tf2|dota2|cs2|csgo|rust)$/i.test(match[1])) return '';

            try {
                return this.normalizeSlugName(decodeURIComponent(match[1]));
            } catch (e) {
                return this.normalizeSlugName(match[1]);
            }
        },
        normalizeSlugName(slug) {
            return normalizeText(String(slug || '')
                .replace(/[-_]+/g, ' ')
                .replace(/\b\w/g, char => char.toUpperCase())
                .replace(/\bCo\b/g, 'Co.'));
        },
        isLikelyItemName(value) {
            const text = normalizeText(value);
            if (text.length < 2) return false;
            if (/[₽$€£¥₴₸₹%]|руб\.?|USD|EUR/i.test(text)) return false;
            if (/^(x\s*)?\d+$/i.test(text)) return false;
            if (/^(tf2|dota2|skins?|скины|оружие|броня|одежда|разное|в корзину|купить|добавить в корзину)$/i.test(text)) return false;

            return true;
        },
        getCardFromLink(link, cardRoot) {
            if (!link || !cardRoot) return null;

            let current = link;
            while (current?.parentElement && current.parentElement !== cardRoot) {
                current = current.parentElement;
            }

            if (!current || current === cardRoot) return null;
            return this.isAvailableCard(current) && this.getPrice(current) && this.getName(current) ? current : null;
        },
        countDirectCards(container) {
            return Array.from(container?.children || [])
                .filter(child => this.getItemLinks(child).length === 1 && this.isAvailableCard(child) && this.getPrice(child) && this.getName(child))
                .length;
        },
        getElementDepth(element) {
            let depth = 0;
            for (let current = element; current?.parentElement; current = current.parentElement) depth++;
            return depth;
        },
        getName(card) {
            const link = card.matches?.('a[href*="/skins/"]') ? card : card.querySelector('a[href*="/skins/"]');
            const textValues = [];
            const addTextValue = value => {
                if (this.isLikelyItemName(value)) textValues.push(normalizeText(value));
            };

            [ATTRIBUTE.marketHashName, 'data-market-name', 'data-item-name', 'data-name', 'data-title', 'title', 'aria-label']
                .forEach(attr => addTextValue(card.getAttribute?.(attr)));
            card.querySelectorAll?.('img[alt], img[title], [data-market-hash-name], [data-market-name], [data-item-name], [data-name], [data-title]')?.forEach(element => {
                [ATTRIBUTE.marketHashName, 'data-market-name', 'data-item-name', 'data-name', 'data-title', 'alt', 'title']
                    .forEach(attr => addTextValue(element.getAttribute?.(attr)));
            });

            return normalizeText(card.getAttribute(ATTRIBUTE.marketHashName)
                || textValues.find(Boolean)
                || this.getNameFromHref(link?.getAttribute('href')));
        },
        getPrice(card) {
            if (isValidPrice(parsePrice(card.getAttribute?.(ATTRIBUTE.price)))) {
                return parsePrice(card.getAttribute(ATTRIBUTE.price));
            }

            const candidates = Array.from(card.querySelectorAll('[data-price], [class*="price" i], [class*="cost" i], [class*="amount" i], [class*="value" i], span, div'))
                .filter(element => !element.closest('.steam-highest-buy-order-link[data-profit-helper-badge="true"]'));

            const priceElement = candidates.find(element => {
                const text = normalizeText(element.getAttribute('data-price') || element.textContent || '');
                return /[₽$€£¥₴₸₹]|руб\.?|USD|EUR/i.test(text)
                    && !/%/.test(text)
                    && isValidPrice(parsePrice(text));
            });

            return priceElement ? parsePrice(priceElement.getAttribute('data-price') || priceElement.textContent) : NaN;
        },
        getDiscount(card) {
            return parseDiscountPercent(card.textContent);
        },
        async loadPage(pageNumber, context) {
            const url = new URL(context.baseUrl);
            url.pathname = url.pathname.replace(/\/page\/\d+\/?$/i, '').replace(/\/$/, '');
            if (pageNumber > 1) url.pathname = `${url.pathname}/page/${pageNumber}`;
            context.searchParams.forEach((value, key) => url.searchParams.set(key, value));
            const doc = await fetchDocument(url.toString(), { signal: context.signal });
            return { page: pageNumber, cards: this.getCards(doc).map(card => document.importNode(card, true)) };
        }
    };

    const ADAPTERS = [TradeitAdapter, SkinportAdapter, WaxpeerAdapter, MoonMarketAdapter, KeysStoreAdapter, SteamTraderAdapter, AvanAdapter, LisAdapter];

    /*************************************************************************
     * Main workflow
     *************************************************************************/

    function detectAppId(defaultAppId = 252490) {
        const href = window.location.href;
        const params = new URLSearchParams(window.location.search);
        const explicit = parseInt(params.get('appId') || params.get('app_id') || params.get('gameId'), 10);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        if (/steam\/store/i.test(href) || params.get('game') === 'steam') return 753;
        if (/dota2/i.test(href)) return 570;
        if (/csgo|cs2/i.test(href)) return 730;
        if (/tf2/i.test(href)) return 440;
        if (/rust/i.test(href)) return 252490;
        return defaultAppId;
    }

    function createBadge(card, adapter = getCardAdapter(card)) {
        const badge = document.createElement('div');
        badge.className = 'steam-highest-buy-order-link';
        badge.setAttribute('data-profit-helper-badge', 'true');
        badge.dataset.refreshing = 'true';
        badge.innerHTML = `
            <a class="profit-helper-badge-link" target="_blank" rel="noopener noreferrer">
                <span class="profit-helper-badge-text">Загружаю</span>
            </a>
            <button type="button" class="profit-helper-badge-refresh" title="Обновить цену" aria-label="Обновить цену" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"></path>
                    <path d="M3 3v5h5"></path>
                    <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"></path>
                    <path d="M16 16h5v5"></path>
                </svg>
            </button>
        `;
        badge.style.background = CONFIG.colors.loading;
        const container = adapter?.getBadgeContainer?.(card) || card;
        container.style.position = 'relative';
        container.appendChild(badge);
        attachProfitTooltip(badge.querySelector('.profit-helper-badge-link'));
        badge.querySelector('.profit-helper-badge-refresh')?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            refreshSingleCard(card, adapter, badge);
        });
        adapter?.onBadgeCreated?.(badge, card);
        return badge;
    }

    function getBadgeLink(badge) {
        return badge?.querySelector?.('.profit-helper-badge-link') || badge;
    }

    function setBadgeText(badge, text) {
        const textElement = badge?.querySelector?.('.profit-helper-badge-text');
        if (textElement) textElement.textContent = text;
        else if (badge) badge.innerText = text;
    }

    function setBadgeHref(badge, href) {
        const link = getBadgeLink(badge);
        if (link && href) link.href = href;
    }

    function setBadgeRefreshing(badge, isRefreshing) {
        if (!badge) return;
        badge.dataset.refreshing = isRefreshing ? 'true' : 'false';
        const button = badge.querySelector?.('.profit-helper-badge-refresh');
        if (button) button.disabled = isRefreshing;
    }

    function getTooltipRows(sitePrice, rows) {
        const rowsLimit = Math.max(1, Math.min(20, readNumberInput('tooltip-rows-input', 3)));
        return (rows || []).slice(0, rowsLimit).map(row => {
            const sale = calculateSteamSale(row.salePrice, sitePrice);
            const profitPercent = (sale.netProfit / sitePrice) * 100;
            return { ...row, ...sale, sitePrice, totalFee: sale.steamFee + sale.gameFee, profitPercent };
        });
    }

    function setBadgeTooltipData(badge, sitePrice, rows) {
        const tooltipRows = getTooltipRows(sitePrice, rows);
        if (!tooltipRows.length) return;

        getBadgeLink(badge).dataset.profitTooltip = JSON.stringify(tooltipRows);
    }

    function hideProfitTooltip() {
        if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
        document.getElementById('profit-helper-tooltip')?.remove();
    }

    function scheduleHideProfitTooltip() {
        if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
        tooltipHideTimer = setTimeout(hideProfitTooltip, 180);
    }

    function keepProfitTooltipVisible() {
        if (!tooltipHideTimer) return;

        clearTimeout(tooltipHideTimer);
        tooltipHideTimer = null;
    }

    function showProfitTooltip(badge, event) {
        const data = badge.dataset.profitTooltip;
        if (!data) return;

        let rows = [];
        try {
            rows = JSON.parse(data);
        } catch (error) {
            return;
        }
        if (!rows.length) return;

        hideProfitTooltip();
        const tooltip = document.createElement('div');
        tooltip.id = 'profit-helper-tooltip';
        tooltip.className = 'profit-helper-tooltip';
        tooltip.innerHTML = `
            <table>
                <thead>
                    <tr><th>Сайт</th><th>Steam</th><th>Заявок</th><th>Комиссия Steam</th><th>После комиссии</th><th>Выгода</th></tr>
                </thead>
                <tbody>
                    ${rows.map(row => `
                        <tr>
                            <td>${formatCurrency(row.sitePrice)}</td>
                            <td>${formatCurrency(row.salePrice)}</td>
                            <td>${row.ordersCount}</td>
                            <td>${formatCurrency(row.totalFee)}</td>
                            <td>${formatCurrency(row.netSale)}</td>
                            <td class="profit-helper-tooltip-profit" style="background:${getProfitColor(row.profitPercent)}">${formatCurrency(row.netProfit)} (${row.profitPercent >= 0 ? '+' : ''}${row.profitPercent.toFixed(2)}%)</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        document.body.appendChild(tooltip);
        tooltip.addEventListener('mouseenter', keepProfitTooltipVisible);
        tooltip.addEventListener('mouseleave', scheduleHideProfitTooltip);

        const left = Math.min(window.innerWidth - tooltip.offsetWidth - 10, event.clientX + 12);
        const top = Math.min(window.innerHeight - tooltip.offsetHeight - 10, event.clientY + 12);
        tooltip.style.left = `${Math.max(10, left)}px`;
        tooltip.style.top = `${Math.max(10, top)}px`;
    }

    function attachProfitTooltip(badge) {
        let timerId = null;
        let lastEvent = null;

        badge.addEventListener('mouseenter', event => {
            lastEvent = event;
            keepProfitTooltipVisible();
            timerId = setTimeout(() => showProfitTooltip(badge, lastEvent), 1000);
        });
        badge.addEventListener('mousemove', event => {
            lastEvent = event;
        });
        badge.addEventListener('mouseleave', () => {
            if (timerId) clearTimeout(timerId);
            timerId = null;
            scheduleHideProfitTooltip();
        });
    }

    function getErroredCards(adapter) {
        return adapter.getCards()
            .filter(card => card.isConnected && card.getAttribute(ATTRIBUTE.result) === RESULT_STATUS.error);
    }

    function updateRetryErrorsButton(adapter = getCurrentAdapter()) {
        const button = document.getElementById('retry-errors-combine');
        if (!button) return;

        const errorsCount = adapter ? getErroredCards(adapter).length : 0;
        button.dataset.visible = errorsCount > 0 && !currentOperation ? 'true' : 'false';
        button.innerText = errorsCount > 0
            ? `Повторить ошибочные: ${errorsCount}`
            : 'Повторить обработку ошибочных';
    }

    function hideRetryErrorsButton() {
        const button = document.getElementById('retry-errors-combine');
        if (button) button.dataset.visible = 'false';
    }

    function resetCardForRetry(card) {
        card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
        card.removeAttribute(ATTRIBUTE.processed);
        card.removeAttribute(ATTRIBUTE.filtered);
        card.removeAttribute(ATTRIBUTE.profit);
        card.removeAttribute(ATTRIBUTE.profitPercent);
        card.removeAttribute(ATTRIBUTE.result);
        card.removeAttribute(ATTRIBUTE.queued);
        card.style.display = '';
    }

    function updateBadgeWithError(card, badge, text, color = CONFIG.colors.negative, resultStatus = RESULT_STATUS.error) {
        restoreCardImages(card);
        setBadgeText(badge, text);
        badge.style.background = color;
        setBadgeRefreshing(badge, false);
        card.setAttribute(ATTRIBUTE.processed, '1');
        card.setAttribute(ATTRIBUTE.result, resultStatus);
        card.setAttribute(ATTRIBUTE.profit, '-999999');
        card.removeAttribute(ATTRIBUTE.profitPercent);
    }

    function getProfitColor(profitPercent) {
        return profitPercent >= 30
            ? CONFIG.colors.excellent
            : profitPercent >= 20
                ? CONFIG.colors.positive
                : profitPercent >= 0
                    ? CONFIG.colors.neutral
                    : CONFIG.colors.negative;
    }

    function updateBadgeWithProfit(card, badge, steamPrice, sitePrice, rows) {
        const sale = calculateSteamSale(steamPrice, sitePrice);
        const profitPercent = (sale.netProfit / sitePrice) * 100;
        if (profitPercent >= readNumberInput('min-profit-input', -100)) restoreCardImages(card);
        card.setAttribute(ATTRIBUTE.profit, String(sale.netProfit));
        card.setAttribute(ATTRIBUTE.profitPercent, String(profitPercent));
        card.setAttribute(ATTRIBUTE.processed, '1');
        card.setAttribute(ATTRIBUTE.result, RESULT_STATUS.success);

        const orderText = rows?.[0]?.ordersCount ? ` [${rows[0].ordersCount} шт.]` : '';
        setBadgeText(badge, `${formatCurrency(steamPrice)}${orderText} (${sale.netProfit >= 0 ? '+' : ''}${formatCurrency(sale.netProfit)}, ${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`);
        setBadgeTooltipData(badge, sitePrice, rows);
        badge.style.background = getProfitColor(profitPercent);
        setBadgeRefreshing(badge, false);
    }

    function sortAndPrune(adapter) {
        const minProfitPercent = readNumberInput('min-profit-input', -100);
        adapter.invalidateCache?.();
        const grid = adapter.getGrid();
        if (!grid) return;

        const processedCards = [];
        const loadingCards = [];
        const queuedCards = [];
        const waitingCards = [];

        adapter.getCards().forEach(card => {
            if (card.hasAttribute(ATTRIBUTE.processed)) processedCards.push(card);
            else if (card.querySelector('.steam-highest-buy-order-link[data-profit-helper-badge="true"]')) loadingCards.push(card);
            else if (card.hasAttribute(ATTRIBUTE.queued)) queuedCards.push(card);
            else waitingCards.push(card);
        });

        processedCards.sort((a, b) => parseFloat(b.getAttribute(ATTRIBUTE.profitPercent) || '-999999')
            - parseFloat(a.getAttribute(ATTRIBUTE.profitPercent) || '-999999'));

        processedCards.forEach(card => {
            const profitPercent = parseFloat(card.getAttribute(ATTRIBUTE.profitPercent));
            if (Number.isFinite(profitPercent) && profitPercent < minProfitPercent) {
                card.remove();
                return;
            }
            card.style.display = '';
            grid.appendChild(card);
        });
        [...loadingCards, ...queuedCards, ...waitingCards].forEach(card => {
            card.style.display = '';
            grid.appendChild(card);
        });
        adapter.invalidateCache?.();
    }

    function collectEligibleCards(adapter, { markQueued = false } = {}) {
        const minDiscount = readNumberInput('discount-input', 0);
        const cards = [];

        adapter.getCards().forEach(card => {
            if (card.hasAttribute(ATTRIBUTE.processed) || card.hasAttribute(ATTRIBUTE.queued)) return;

            const discount = adapter.getDiscount(card);
            if (minDiscount > 0 && (discount === null || discount < minDiscount)) {
                parkCardImages(card);
                card.remove();
                return;
            }

            if (markQueued) {
                card.setAttribute(ATTRIBUTE.queued, '1');
                parkCardImages(card);
            }
            cards.push(card);
        });

        return cards;
    }

    function passesDiscountFilter(adapter, card) {
        const minDiscount = readNumberInput('discount-input', 0);
        const discount = adapter.getDiscount(card);
        return minDiscount <= 0 || (discount !== null && discount >= minDiscount);
    }

    function parkCardImages(card) {
        card.querySelectorAll('img').forEach(img => {
            if (img.dataset.profitOriginalSrc === undefined) {
                img.dataset.profitOriginalSrc = img.getAttribute('src') || '';
                img.dataset.profitOriginalSrcset = img.getAttribute('srcset') || '';
                img.dataset.profitOriginalDataSrc = img.getAttribute('data-src') || '';
                img.dataset.profitOriginalDataLazySrc = img.getAttribute('data-lazy-src') || '';
            }
            img.loading = 'lazy';
            img.removeAttribute('src');
            img.removeAttribute('srcset');
            img.removeAttribute('data-src');
            img.removeAttribute('data-lazy-src');
        });
    }

    function restoreCardImages(card) {
        card.querySelectorAll('img').forEach(img => {
            if (img.dataset.profitOriginalSrc) img.setAttribute('src', img.dataset.profitOriginalSrc);
            if (img.dataset.profitOriginalSrcset) img.setAttribute('srcset', img.dataset.profitOriginalSrcset);
            if (img.dataset.profitOriginalDataSrc) img.setAttribute('data-src', img.dataset.profitOriginalDataSrc);
            if (img.dataset.profitOriginalDataLazySrc) img.setAttribute('data-lazy-src', img.dataset.profitOriginalDataLazySrc);
            delete img.dataset.profitOriginalSrc;
            delete img.dataset.profitOriginalSrcset;
            delete img.dataset.profitOriginalDataSrc;
            delete img.dataset.profitOriginalDataLazySrc;
        });
    }

    function restoreAllParkedImages(root = document) {
        const cards = uniqueElements(Array.from(root.querySelectorAll('img[data-profit-original-src]'))
            .map(img => img.closest(`[${ATTRIBUTE.queued}], [${ATTRIBUTE.processed}]`) || img.parentElement));
        cards.forEach(restoreCardImages);
    }

    function addLoadedCardsToPending(operation, adapter, cards) {
        cards.forEach(card => {
            if (!passesDiscountFilter(adapter, card)) {
                parkCardImages(card);
                card.remove();
                return;
            }

            card.remove();
            parkCardImages(card);
            operation.pendingDetachedCards.push(card);
        });
    }

    function appendDetachedCards(operation, adapter) {
        const grid = adapter.getGrid();
        if (!grid || operation.pendingDetachedCards.length === 0) return [];

        const cards = operation.pendingDetachedCards.splice(0);
        const fragment = document.createDocumentFragment();
        cards.forEach(card => {
            card.setAttribute(ATTRIBUTE.queued, '1');
            fragment.appendChild(card);
        });
        grid.appendChild(fragment);
        return cards;
    }

    function getPendingEligibleCount(operation, adapter) {
        return collectEligibleCards(adapter).length + operation.pendingDetachedCards.length;
    }

    function getCardsForSteam(adapter, operation = null) {
        const cards = collectEligibleCards(adapter, { markQueued: true });
        if (operation) cards.push(...appendDetachedCards(operation, adapter));
        return cards;
    }

    function getResultStats(adapter) {
        const stats = { total: 0, profitable: 0, errors: 0, noOrders: 0, notFound: 0 };
        adapter.getCards().forEach(card => {
            if (!card.hasAttribute(ATTRIBUTE.processed)) return;

            stats.total++;
            const profitPercent = parseFloat(card.getAttribute(ATTRIBUTE.profitPercent));
            const resultStatus = card.getAttribute(ATTRIBUTE.result);
            if (resultStatus === RESULT_STATUS.noOrders) stats.noOrders++;
            else if (resultStatus === RESULT_STATUS.notFound) stats.notFound++;
            else if (resultStatus === RESULT_STATUS.error) stats.errors++;
            else if (!Number.isFinite(profitPercent)) stats.errors++;
            else if (profitPercent >= 20) stats.profitable++;
        });
        return stats;
    }

    function formatResultStats(adapter, operation = null) {
        const stats = getResultStats(adapter);
        const processedTotal = operation?.steamDone ?? stats.total;
        return `Готово: обработано всего ${processedTotal}, в результатах ${stats.total}, выгодных ${stats.profitable}, ошибок ${stats.errors}, без заявок ${stats.noOrders}, не найдено ${stats.notFound}`;
    }

    async function refreshSingleCard(card, adapter, badge) {
        if (!card?.isConnected || badge?.dataset.refreshing === 'true') return;

        const cardAdapter = getCardAdapter(card, adapter);
        setBadgeRefreshing(badge, true);
        setBadgeText(badge, 'Обновляю цену');
        badge.style.background = CONFIG.colors.loading;
        delete getBadgeLink(badge).dataset.profitTooltip;
        logWork('INFO', 'Ручное обновление цены', {
            site: cardAdapter.id,
            cardName: cardAdapter.getName(card)
        });

        try {
            await processCard(null, cardAdapter, card, {
                badge,
                forceSteamRefresh: true
            });
            logWork('INFO', 'Ручное обновление завершено', {
                site: cardAdapter.id,
                cardName: cardAdapter.getName(card),
                result: card.getAttribute(ATTRIBUTE.result)
            });
        } catch (error) {
            logWork('ERROR', 'Ошибка ручного обновления', {
                site: cardAdapter.id,
                cardName: cardAdapter.getName(card),
                error: error.message || String(error)
            });
            updateBadgeWithError(card, badge, `Обновление: ${error.message || 'ошибка'}`);
        } finally {
            setBadgeRefreshing(badge, false);
            if (card.isConnected) sortAndPrune(adapter);
            updateRetryErrorsButton(adapter);
        }
    }

    async function processCard(operation, adapter, card, { badge: existingBadge = null, forceSteamRefresh = false } = {}) {
        if (operation && !isOperationActive(operation)) return;

        const cardAdapter = getCardAdapter(card, adapter);
        const name = cardAdapter.getName(card);
        const steamMarketHashName = cardAdapter.getSteamMarketHashName
            ? cardAdapter.getSteamMarketHashName(card)
            : name;
        const sitePrice = cardAdapter.getPrice(card);
        const appId = cardAdapter.getAppId();
        const badge = existingBadge || createBadge(card, cardAdapter);

        if (!steamMarketHashName) {
            logWork('ERROR', 'Не удалось определить имя предмета', {
                site: cardAdapter.id,
                cardName: name,
                appId
            });
            updateBadgeWithError(card, badge, 'Имя не найдено');
            if (operation) {
                operation.steamDone++;
                updateStatus(operation);
            }
            return;
        }
        if (!isValidPrice(sitePrice)) {
            logWork('ERROR', 'Некорректная цена сайта', {
                site: cardAdapter.id,
                cardName: name,
                marketHashName: steamMarketHashName,
                price: sitePrice
            });
            updateBadgeWithError(card, badge, 'Ошибка цены сайта');
            if (operation) {
                operation.steamDone++;
                updateStatus(operation);
            }
            return;
        }

        const targetUrl = cardAdapter.getSteamListingUrl?.(card, steamMarketHashName)
            || buildSteamListingUrl(appId, steamMarketHashName);
        setBadgeHref(badge, targetUrl);

        try {
            const result = await fetchSteamBestBuyOrder(appId, steamMarketHashName, {
                forceRefresh: forceSteamRefresh
            });
            if (result.status === 'not-found') {
                logWork('WARN', 'Предмет не найден в Steam', {
                    site: cardAdapter.id,
                    cardName: name,
                    marketHashName: steamMarketHashName,
                    appId,
                    url: targetUrl
                });
                updateBadgeWithError(card, badge, 'Предмет не найден', CONFIG.colors.notFound, RESULT_STATUS.notFound);
            } else if (result.status === 'no-orders') {
                logWork('WARN', 'У предмета нет заявок Steam', {
                    site: cardAdapter.id,
                    marketHashName: steamMarketHashName,
                    appId,
                    url: targetUrl
                });
                updateBadgeWithError(card, badge, 'Нет заявок', CONFIG.colors.noOrders, RESULT_STATUS.noOrders);
            } else {
                updateBadgeWithProfit(card, badge, result.steamPrice, sitePrice, result.rows);
            }
        } catch (error) {
            logWork('ERROR', 'Ошибка запроса Steam', {
                site: cardAdapter.id,
                marketHashName: steamMarketHashName,
                appId,
                url: targetUrl,
                error: error.message || String(error)
            });
            updateBadgeWithError(card, badge, `Steam: ${error.message || 'ошибка'}`);
        } finally {
            if (operation) {
                operation.steamDone++;
                if (operation.steamDone % CONFIG.intermediateSortEvery === 0) sortAndPrune(adapter);
                updateStatus(operation);
            }
        }
    }

    async function runSteamWorkers(operation, adapter, cards) {
        if (!cards.length) return;

        steamQueue.push(...cards);
        operation.steamTotal += cards.length;
        operation.pendingSteamTotal = Math.max(0, operation.pendingSteamTotal - cards.length);
        updateStatus(operation);

        const workersCount = Math.max(1, Math.min(99, readNumberInput('steam-workers-input', 3)));
        const worker = async () => {
            while (isOperationActive(operation) && steamQueue.length) {
                const card = steamQueue.shift();
                await processCard(operation, adapter, card);
            }
        };

        steamQueueRunning = true;
        await Promise.all(Array.from({ length: Math.min(workersCount, cards.length) }, () => worker()));
        steamQueueRunning = false;
        sortAndPrune(adapter);
    }

    async function processIntermediateCards(operation, adapter) {
        while (isOperationActive(operation)) {
            const cardsCount = getPendingEligibleCount(operation, adapter);
            operation.pendingSteamTotal = cardsCount;

            const remaining = Math.max(CONFIG.intermediateSteamThreshold - cardsCount, 0);
            operation.pendingToIntermediateText = remaining > 0
                ? `До промежуточной обработки ${remaining} карточек`
                : 'Запускаю промежуточную обработку';
            updateStatus(operation);

            if (operation.intermediateSteamPromise) {
                if (cardsCount >= CONFIG.intermediateSteamThreshold) {
                    await operation.intermediateSteamPromise;
                    continue;
                }
                return null;
            }

            if (cardsCount < CONFIG.intermediateSteamThreshold) return null;

            const cards = getCardsForSteam(adapter, operation);
            operation.pendingSteamTotal = getPendingEligibleCount(operation, adapter);
            operation.pendingToIntermediateText = '';
            operation.intermediateSteamPromise = runSteamWorkers(operation, adapter, cards)
                .finally(() => {
                    operation.intermediateSteamPromise = null;
                });
            return null;
        }

        return null;
    }

    async function loadExtraPages(operation, adapter, pagesCount) {
        const grid = adapter.getGrid();
        if (!grid || pagesCount <= 0) return;

        const siteWorkersLimit = adapter.maxSiteWorkers || 33;
        const siteWorkers = Math.max(1, Math.min(siteWorkersLimit, readNumberInput('site-workers-input', 4)));
        const context = {
            baseUrl: window.location.origin + window.location.pathname,
            searchParams: new URLSearchParams(window.location.search)
        };
        const getRequestedPagesCount = () => Math.max(0, Math.min(999,
            readNumberInput('pages-input', pagesCount)));
        let lastRequestedPagesCount = getRequestedPagesCount();
        const updateRequestedPagesCount = () => {
            const requestedPagesCount = getRequestedPagesCount();
            operation.siteTotal = Math.max(operation.siteLoaded, requestedPagesCount);
            updateStatus(operation);

            if (requestedPagesCount !== lastRequestedPagesCount) {
                logWork('INFO', 'Изменено количество страниц', {
                    site: adapter.id,
                    pages: requestedPagesCount
                });
                lastRequestedPagesCount = requestedPagesCount;
            }
        };
        const pagesInputs = [
            document.getElementById('pages-input'),
            document.getElementById('pages-input-range')
        ].filter(Boolean);
        const removePagesInputListeners = () => {
            pagesInputs.forEach(input => input.removeEventListener('input', updateRequestedPagesCount));
            operation.cleanups.delete(removePagesInputListeners);
        };
        pagesInputs.forEach(input => input.addEventListener('input', updateRequestedPagesCount));
        operation.cleanups.add(removePagesInputListeners);

        operation.siteTotal = lastRequestedPagesCount;
        operation.siteLoaded = 0;

        let nextPage = 2;
        const worker = async () => {
            while (isOperationActive(operation) && !operation.stopLoadingRequested) {
                const requestedPagesCount = getRequestedPagesCount();
                operation.siteTotal = Math.max(operation.siteLoaded, requestedPagesCount);
                if (nextPage > requestedPagesCount + 1) return;
                const pageNumber = nextPage++;

                const { signal, cleanup } = withTimeout(operation, CONFIG.siteTimeoutMs);
                try {
                    const result = await adapter.loadPage(pageNumber, { ...context, signal });
                    addLoadedCardsToPending(operation, adapter, result.cards);
                    logWork('INFO', 'Страница сайта загружена', {
                        site: adapter.id,
                        page: pageNumber,
                        cards: result.cards.length
                    });
                    const pendingCount = getPendingEligibleCount(operation, adapter);
                    operation.pendingSteamTotal = pendingCount;
                    await processIntermediateCards(operation, adapter);
                } catch (error) {
                    if (operation.stopLoadingRequested) return;
                    showToast(`Страница ${pageNumber}: ${error.message || 'ошибка загрузки'}`, 'error');
                } finally {
                    cleanup();
                    operation.cleanups.delete(cleanup);
                    operation.siteLoaded++;
                    operation.siteTotal = Math.max(operation.siteLoaded, getRequestedPagesCount());
                    updateStatus(operation);
                }

                if (nextPage <= getRequestedPagesCount() + 1 && isOperationActive(operation) && !operation.stopLoadingRequested) {
                    const pageDelaySeconds = Math.max(0, Math.min(10, readNumberInput('page-delay-input', 1)));
                    await waitForOperationDelay(operation, pageDelaySeconds * 1000);
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: Math.min(siteWorkers, pagesCount) }, () => worker()));
            if (operation.stopLoadingRequested) operation.siteTotal = operation.siteLoaded;
        } finally {
            removePagesInputListeners();
        }
    }

    async function reloadInitialPage(operation, adapter) {
        if (!adapter.reloadInitialPage) return;

        let grid = adapter.getGrid();
        if (!grid && adapter.createGrid) grid = adapter.createGrid();
        if (!grid) return;
        grid = adapter.prepareReloadGrid?.(grid) || grid;

        setStatus('Загружаю первую страницу через API...');
        adapter.getCards().forEach(card => card.remove());
        const { signal, cleanup } = withTimeout(operation, CONFIG.siteTimeoutMs);
        try {
            const result = await adapter.loadPage(1, { signal });
            const fragment = document.createDocumentFragment();
            result.cards.forEach(card => fragment.appendChild(card));
            grid.appendChild(fragment);
            logWork('INFO', 'Начальная страница загружена через API', {
                site: adapter.id,
                cards: result.cards.length
            });
        } finally {
            cleanup();
            operation.cleanups.delete(cleanup);
        }
    }

    async function runRetryErroredCards() {
        if (currentOperation) {
            cancelOperation();
            return;
        }

        const adapter = getCurrentAdapter();
        if (!adapter) {
            showToast('Сайт не поддерживается', 'error');
            return;
        }

        const cards = getErroredCards(adapter);
        if (!cards.length) {
            updateRetryErrorsButton(adapter);
            showToast('Ошибочных карточек нет.');
            return;
        }

        const operation = createOperation();
        logWork('INFO', 'Повторная обработка ошибочных карточек', {
            operation: operation.id,
            site: adapter.id,
            cards: cards.length,
            steamWorkers: readNumberInput('steam-workers-input', 3)
        });
        setStartButtonLoading(true);
        hideRetryErrorsButton();
        setStatus(`Повторяю ошибочные карточки: ${cards.length}`);

        try {
            cards.forEach(card => {
                resetCardForRetry(card);
                card.setAttribute(ATTRIBUTE.result, RESULT_STATUS.error);
            });
            await runSteamWorkers(operation, adapter, cards);
            if (!isOperationActive(operation)) return;

            sortAndPrune(adapter);
            const resultText = formatResultStats(adapter, operation);
            finishOperation(operation, resultText);
            updateRetryErrorsButton(adapter);
            showToast(getErroredCards(adapter).length ? 'Повтор завершен, часть карточек снова с ошибкой.' : 'Ошибочные карточки обработаны.');
        } catch (error) {
            showToast(error.message || 'Ошибка выполнения', 'error');
            finishOperation(operation, error.message || 'Ошибка выполнения');
            updateRetryErrorsButton(adapter);
        }
    }

    async function runSearch() {
        if (currentOperation) {
            cancelOperation();
            return;
        }

        const adapter = getCurrentAdapter();
        if (!adapter) {
            showToast('Сайт не поддерживается', 'error');
            return;
        }

        const operation = createOperation();
        logWork('INFO', 'Запуск обработки', {
            operation: operation.id,
            site: adapter.id,
            discount: readNumberInput('discount-input', 0),
            pages: readNumberInput('pages-input', 0),
            siteWorkers: readNumberInput('site-workers-input', 4),
            pageDelay: readNumberInput('page-delay-input', 1),
            steamWorkers: readNumberInput('steam-workers-input', 3),
            minProfit: readNumberInput('min-profit-input', -100)
        });
        setStartButtonLoading(true);
        hideRetryErrorsButton();
        setStatus('Подготовка...');

        try {
            resetCards(adapter);
            await reloadInitialPage(operation, adapter);
            if (!isOperationActive(operation)) return;

            const pagesCount = adapter.supportsPagination === false
                ? 0
                : Math.max(0, Math.min(999, readNumberInput('pages-input', 0)));
            await loadExtraPages(operation, adapter, pagesCount);
            if (!isOperationActive(operation)) return;

            operation.pendingToIntermediateText = '';
            if (operation.intermediateSteamPromise) {
                await operation.intermediateSteamPromise;
                if (!isOperationActive(operation)) return;
            }

            const cards = getCardsForSteam(adapter, operation);
            if (cards.length === 0) {
                const resultText = operation.steamTotal > 0
                    ? formatResultStats(adapter, operation)
                    : `Готово: обработано всего ${operation.steamDone}. Подходящих карточек нет.`;
                finishOperation(operation, resultText);
                updateRetryErrorsButton(adapter);
                showToast(resultText);
                return;
            }

            await runSteamWorkers(operation, adapter, cards);
            if (!isOperationActive(operation)) return;

            sortAndPrune(adapter);
            const resultText = formatResultStats(adapter, operation);
            finishOperation(operation, resultText);
            updateRetryErrorsButton(adapter);
            showToast('Готово!');
        } catch (error) {
            showToast(error.message || 'Ошибка выполнения', 'error');
            finishOperation(operation, error.message || 'Ошибка выполнения');
            updateRetryErrorsButton(adapter);
        }
    }

    /*************************************************************************
     * Boot
     *************************************************************************/

    function boot() {
        if (!document.documentElement) {
            setTimeout(boot, 0);
            return;
        }

        const observer = new MutationObserver(() => injectPanel());
        observer.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', injectPanel, { once: true });
        window.addEventListener('load', injectPanel, { once: true });
        setInterval(injectPanel, 1500);
        injectPanel();
    }

    boot();
})();
