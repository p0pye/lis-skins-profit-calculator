// ==UserScript==
// @name         lis-skins-profit-calculator
// @namespace    http://tampermonkey.net
// @version      17.0
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
        steamTimeoutMs: 20000,
        siteTimeoutMs: 20000,
        steamCacheTtlMs: 5 * 60 * 1000,
        maxSteamCacheEntries: 3000,
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
    const ATTRIBUTE = {
        processed: 'data-profit-helper-processed',
        filtered: 'data-profit-helper-filtered',
        profit: 'data-calculated-profit',
        profitPercent: 'data-calculated-profit-percent',
        queued: 'data-profit-helper-queued',
        marketHashName: 'data-market-hash-name',
        price: 'data-price',
        discount: 'data-discount'
    };

    let panelInjected = false;
    let currentOperation = null;
    let operationId = 0;
    let steamQueue = [];
    let steamQueueRunning = false;
    let tooltipHideTimer = null;
    const steamCache = new Map();

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

        currentOperation = null;
        steamQueue = [];
        operation.pendingDetachedCards = [];
        steamQueueRunning = false;
        setStartButtonLoading(false);
        setStatus(text);
    }

    function cancelOperation() {
        const operation = currentOperation;
        if (!operation) return;

        if (operation.siteTotal > operation.siteLoaded && !operation.stopLoadingRequested) {
            operation.stopLoadingRequested = true;
            operation.cleanups.forEach(cleanup => {
                try { cleanup(); } catch (e) {}
            });
            setStatus('Останавливаю загрузку страниц...\nОбработаю уже загруженные карточки.');
            return;
        }

        operation.cancelled = true;
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
        for (let index = 0; index + 1 < compactOrders.length; index += 2) {
            const salePrice = Number(compactOrders[index]) / 100;
            const ordersCount = String(compactOrders[index + 1] ?? '').replace(/\s| /g, '');
            if (!isValidPrice(salePrice) || !ordersCount) continue;

            rows.push({ salePrice, ordersCount });
        }
        return rows;
    }

    async function fetchSteamBestBuyOrder(appId, marketHashName) {
        pruneSteamCache();
        const cacheKey = `${appId}:${marketHashName}`;
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

    function setStatus(text) {
        const status = document.getElementById('combine-status');
        if (status) status.innerText = text || '';
    }

    function showToast(message, kind = 'success') {
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
                background: ${CONFIG.colors.panelBg}; color: ${CONFIG.colors.text};
                border: 1px solid ${CONFIG.colors.panelBorder};
                box-shadow: 0 4px 15px rgba(0,0,0,.8);
                font: 13px Arial, "Helvetica Neue", sans-serif;
            }
            #profit-helper-panel[data-collapsed="true"] {
                left: 0; width: 28px; min-width: 28px; padding: 8px 3px;
                border-radius: 0 8px 8px 0; cursor: pointer;
            }
            .profit-title {
                color: ${CONFIG.colors.panelAccent}; font-weight: bold; text-align: center; margin-bottom: 14px;
                cursor: pointer; user-select: none;
            }
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
                color: #fff !important; padding: 3px 8px; font: bold 11px Arial, sans-serif;
                border-radius: 4px; text-decoration: none !important; line-height: 1.25;
                white-space: normal; overflow-wrap: anywhere; box-shadow: 0 2px 5px rgba(0,0,0,.3);
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
            steamWorkers: localStorage.getItem('profit_helper_steam_workers') || '3',
            minProfit: localStorage.getItem('profit_helper_min_profit') || '-100',
            tooltipRows: localStorage.getItem('profit_helper_tooltip_rows') || '3'
        };

        const panel = document.createElement('div');
        panel.id = 'profit-helper-panel';
        panel.dataset.collapsed = localStorage.getItem('profit_helper_panel_collapsed') === '1' ? 'true' : 'false';
        panel.innerHTML = `
            <div class="profit-title" title="Свернуть/развернуть панель">Profit-Calculator</div>
            <div class="profit-panel-content">
                ${settingRow('Скидка, от %:', 'discount-input', saved.discount, 0, 100, CONFIG.colors.panelAccent, 'Минимальная скидка сайта.')}
                ${settingRow('Страниц сайта:', 'pages-input', saved.pages, 0, 999, CONFIG.colors.panelSecondary, 'Сколько дополнительных страниц сайта загрузить.')}
                ${settingRow('Потоков сайта:', 'site-workers-input', saved.siteWorkers, 1, 33, CONFIG.colors.neutral, 'Сколько страниц сайта грузить одновременно.')}
                ${settingRow('Запросов Steam:', 'steam-workers-input', saved.steamWorkers, 1, 99, CONFIG.colors.panelSuccess, 'Сколько запросов Steam делать одновременно.')}
                ${settingRow('Мин. выгода, от %:', 'min-profit-input', saved.minProfit, -100, 30, CONFIG.colors.negative, 'Скрывать карточки ниже этой выгоды после расчета.')}
                ${settingRow('Строк в таблице:', 'tooltip-rows-input', saved.tooltipRows, 1, 20, CONFIG.colors.panelAccent, 'Сколько строк заявок показывать в таблице при наведении.')}
                <button id="start-combine" type="button">Найти выгодные</button>
                <div id="combine-status"></div>
            </div>
        `;
        document.body.appendChild(panel);

        const toggleCollapsed = () => {
            const collapsed = panel.dataset.collapsed !== 'true';
            panel.dataset.collapsed = collapsed ? 'true' : 'false';
            localStorage.setItem('profit_helper_panel_collapsed', collapsed ? '1' : '0');
        };
        panel.querySelector('.profit-title')?.addEventListener('click', toggleCollapsed);
        panel.addEventListener('click', event => {
            if (panel.dataset.collapsed !== 'true' || event.target.closest('.profit-title')) return;
            toggleCollapsed();
        });

        bindNumberControls(panel);
        [
            ['discount-input', 'profit_helper_discount'],
            ['pages-input', 'profit_helper_pages'],
            ['site-workers-input', 'profit_helper_site_workers'],
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
            badge.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (badge.href) window.open(badge.href, '_blank', 'noopener');
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
            return elements.find(element => this.isNameCandidate(element, this.getNameText(element))) || null;
        },
        getName(card) {
            const storedName = this.cleanName(card.getAttribute(ATTRIBUTE.marketHashName));
            if (storedName) return storedName;

            const link = this.getPrimaryItemLink(card);
            const linkName = this.cleanName(this.getNameAttribute(link));
            if (linkName && this.isNameCandidate(link, linkName)) return linkName;

            const nameElement = this.getNameElement(card);
            const elementName = this.getNameText(nameElement);
            if (elementName) return elementName;

            return this.cleanName(link?.querySelector('img')?.getAttribute('alt'));
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
            const cardText = normalizeText(card.textContent);
            const fullWearMatch = cardText.match(/\b(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\b/i);
            if (fullWearMatch) return fullWearMatch[1];

            const wearAliases = {
                FN: 'Factory New',
                MW: 'Minimal Wear',
                FT: 'Field-Tested',
                WW: 'Well-Worn',
                BS: 'Battle-Scarred'
            };
            const shortWearMatch = cardText.match(/(?:^|[\s/|])(?:FN|MW|FT|WW|BS)(?=$|[\s/|])/i);
            return shortWearMatch ? wearAliases[shortWearMatch[0].replace(/[\s/|]/g, '').toUpperCase()] || '' : '';
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
        getSteamMarketHashName(card) {
            const appId = this.getAppId();
            let itemName = this.getBestMarketHashName(card, appId);
            if (!itemName || appId !== 730) return this.normalizeSteamMarketHashName(itemName, appId);

            const cardText = normalizeText(card.textContent);
            const exteriorText = this.getCsExteriorText(card);
            const wearPattern = /\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i;
            const hasStatTrakPrefix = /^StatTrak™?\s+/i.test(itemName) || /^★\s+StatTrak™?\s+/i.test(itemName);
            const hasSouvenirPrefix = /^Souvenir\s+/i.test(itemName) || /^★\s+Souvenir\s+/i.test(itemName);

            if (/(?:^|[\s/|])ST™?(?=$|[\s/|])|StatTrak™?/i.test(cardText) && !hasStatTrakPrefix) {
                itemName = `StatTrak™ ${itemName}`;
            } else if (/(?:^|[\s/|])Souvenir(?=$|[\s/|])/i.test(cardText) && !hasSouvenirPrefix) {
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
            const exactPrice = parsePrice(firstText(card, ['[data-price]', '.price', '[class*="price" i]']));
            if (isValidPrice(exactPrice)) return exactPrice;

            const text = normalizeText(card.textContent);
            const priceMatch = text.match(/(?:[$€₽₴₸]\s*)?\d[\d\s.,]*\s*(?:[$€₽₴₸]|USD|RUB|UAH|KZT|EUR)/i);
            return parsePrice(priceMatch?.[0] || text);
        },
        getDiscount(card) {
            const exactDiscount = parseDiscountPercent(firstText(card, [
                '[class*="discount" i]',
                '[class*="sale" i]',
                '[class*="percent" i]'
            ]));
            if (exactDiscount !== null) return exactDiscount;

            return parseDiscountPercent(card.textContent);
        },
        getItemHrefFromName(name) {
            return buildSteamListingUrl(this.getAppId(), name);
        },
        getImageUrl(card) {
            return Array.from(card.querySelectorAll?.('img') || [])
                .map(img => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '')
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
                items.push({ name: directName, price, imageUrl, discount, count, href });
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
                price,
                imageUrl: this.getImageUrl(card),
                discount: this.getDiscount(card),
                count,
                href: link?.href || link?.getAttribute?.('href') || ''
            };
        },
        resetGeneratedCard(card) {
            card.querySelectorAll('.steam-highest-buy-order-link[data-profit-helper-badge="true"]').forEach(badge => badge.remove());
            card.removeAttribute(ATTRIBUTE.processed);
            card.removeAttribute(ATTRIBUTE.filtered);
            card.removeAttribute(ATTRIBUTE.profit);
            card.removeAttribute(ATTRIBUTE.profitPercent);
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
            card.setAttribute(ATTRIBUTE.marketHashName, item.name);
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
            const doc = await fetchDocument(url.toString(), { signal: context.signal });
            const cards = this.getCards(doc);
            if (cards.length) {
                return {
                    page: pageNumber,
                    cards: cards.map(card => {
                        const item = this.itemFromCard(card);
                        return item ? this.makeCard(item) : document.importNode(card, true);
                    })
                };
            }

            return { page: pageNumber, cards: this.extractItems(doc).map(item => this.makeCard(item)) };
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
                    display: block !important;
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
            const nativeTemplate = cards.find(card => !card.classList.contains('tradeit-generated-card'));
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
        findSelectedRate(value, seen = new WeakSet()) {
            if (!value || typeof value !== 'object') return NaN;
            if (seen.has(value)) return NaN;
            seen.add(value);

            if (value.selectedCurrency && isValidPrice(Number(value.selectedRate))) return Number(value.selectedRate);

            for (const nested of Object.values(value)) {
                const rate = this.findSelectedRate(nested, seen);
                if (isValidPrice(rate)) return rate;
            }

            return NaN;
        },
        getSelectedRate() {
            const runtimeRate = this.findSelectedRate(window.__NUXT__);
            if (isValidPrice(runtimeRate)) return runtimeRate;

            const scriptsText = Array.from(document.scripts)
                .map(script => script.textContent || '')
                .find(text => text.includes('"selectedCurrency"') && text.includes('"selectedRate"'))
                || '';
            const match = scriptsText.match(/"selectedCurrency":\d+,"selectedRate":\d+,"rates":\d+\},"[A-Z0-9]+",([0-9.]+)/);
            const rate = match ? Number(match[1]) : NaN;
            return isValidPrice(rate) ? rate : 1;
        },
        convertStorePrice(rawPrice) {
            return Math.round((rawPrice / 100) * this.getSelectedRate() * 100) / 100;
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
            [ATTRIBUTE.processed, ATTRIBUTE.filtered, ATTRIBUTE.profit, ATTRIBUTE.profitPercent, ATTRIBUTE.queued].forEach(attribute => {
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

            const imageValue = getDeepValue(item, ['image', 'imageUrl', 'imageURL', 'img', 'imgUrl', 'imgURL', 'iconUrl', 'iconURL']);
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
            const data = await fetchJson(this.buildUrl(pageNumber), { signal: context.signal, credentials: 'include' });
            const cards = this.findItems(data).map(item => this.makeCard(item, data?.counts || {})).filter(Boolean);
            return { page: pageNumber, cards };
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

    const ADAPTERS = [TradeitAdapter, KeysStoreAdapter, SteamTraderAdapter, AvanAdapter, LisAdapter];

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
        const badge = document.createElement('a');
        badge.className = 'steam-highest-buy-order-link';
        badge.setAttribute('data-profit-helper-badge', 'true');
        badge.target = '_blank';
        badge.innerText = 'Загружаю';
        badge.style.background = CONFIG.colors.loading;
        const container = adapter?.getBadgeContainer?.(card) || card;
        container.style.position = 'relative';
        container.appendChild(badge);
        attachProfitTooltip(badge);
        adapter?.onBadgeCreated?.(badge, card);
        return badge;
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

        badge.dataset.profitTooltip = JSON.stringify(tooltipRows);
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

    function updateBadgeWithError(card, badge, text, color = CONFIG.colors.negative) {
        badge.innerText = text;
        badge.style.background = color;
        card.setAttribute(ATTRIBUTE.processed, '1');
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
        card.setAttribute(ATTRIBUTE.profit, String(sale.netProfit));
        card.setAttribute(ATTRIBUTE.profitPercent, String(profitPercent));
        card.setAttribute(ATTRIBUTE.processed, '1');

        const orderText = rows?.[0]?.ordersCount ? ` [${rows[0].ordersCount} шт.]` : '';
        badge.innerText = `${formatCurrency(steamPrice)}${orderText} (${sale.netProfit >= 0 ? '+' : ''}${formatCurrency(sale.netProfit)}, ${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)`;
        setBadgeTooltipData(badge, sitePrice, rows);
        badge.style.background = getProfitColor(profitPercent);
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
                card.remove();
                return;
            }

            if (markQueued) card.setAttribute(ATTRIBUTE.queued, '1');
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
            }
            img.loading = 'lazy';
            img.removeAttribute('src');
            img.removeAttribute('srcset');
        });
    }

    function restoreCardImages(card) {
        card.querySelectorAll('img').forEach(img => {
            if (img.dataset.profitOriginalSrc) img.setAttribute('src', img.dataset.profitOriginalSrc);
            if (img.dataset.profitOriginalSrcset) img.setAttribute('srcset', img.dataset.profitOriginalSrcset);
            delete img.dataset.profitOriginalSrc;
            delete img.dataset.profitOriginalSrcset;
        });
    }

    function addLoadedCardsToPending(operation, adapter, cards) {
        cards.forEach(card => {
            if (!passesDiscountFilter(adapter, card)) {
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
            restoreCardImages(card);
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
        const stats = { total: 0, profitable: 0, errors: 0, noOrders: 0 };
        adapter.getCards().forEach(card => {
            if (!card.hasAttribute(ATTRIBUTE.processed)) return;

            stats.total++;
            const badgeText = card.querySelector('.steam-highest-buy-order-link[data-profit-helper-badge="true"]')?.innerText || '';
            const profitPercent = parseFloat(card.getAttribute(ATTRIBUTE.profitPercent));
            if (badgeText === 'Нет заявок') stats.noOrders++;
            else if (!Number.isFinite(profitPercent)) stats.errors++;
            else if (profitPercent >= 20) stats.profitable++;
        });
        return stats;
    }

    function formatResultStats(adapter) {
        const stats = getResultStats(adapter);
        return `Готово: карточек ${stats.total}, выгодных ${stats.profitable}, ошибок ${stats.errors}, без заявок ${stats.noOrders}`;
    }

    async function processCard(operation, adapter, card) {
        if (!isOperationActive(operation)) return;

        const cardAdapter = getCardAdapter(card, adapter);
        const name = cardAdapter.getName(card);
        const steamMarketHashName = cardAdapter.getSteamMarketHashName?.(card) || name;
        const sitePrice = cardAdapter.getPrice(card);
        const appId = cardAdapter.getAppId();
        const badge = createBadge(card, cardAdapter);

        if (!steamMarketHashName) {
            updateBadgeWithError(card, badge, 'Имя не найдено');
            operation.steamDone++;
            updateStatus(operation);
            return;
        }
        if (!isValidPrice(sitePrice)) {
            updateBadgeWithError(card, badge, 'Ошибка цены сайта');
            operation.steamDone++;
            updateStatus(operation);
            return;
        }

        const targetUrl = cardAdapter.getSteamListingUrl?.(card, steamMarketHashName)
            || buildSteamListingUrl(appId, steamMarketHashName);
        badge.href = targetUrl;

        try {
            const result = await fetchSteamBestBuyOrder(appId, steamMarketHashName);
            if (result.status === 'not-found') {
                updateBadgeWithError(card, badge, 'Предмет не найден', CONFIG.colors.notFound);
            } else if (result.status === 'no-orders') {
                updateBadgeWithError(card, badge, 'Нет заявок', CONFIG.colors.noOrders);
            } else {
                updateBadgeWithProfit(card, badge, result.steamPrice, sitePrice, result.rows);
            }
        } catch (error) {
            updateBadgeWithError(card, badge, `Steam: ${error.message || 'ошибка'}`);
        } finally {
            operation.steamDone++;
            if (operation.steamDone % CONFIG.intermediateSortEvery === 0) sortAndPrune(adapter);
            updateStatus(operation);
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
        operation.siteTotal = pagesCount;
        operation.siteLoaded = 0;

        let nextPage = 2;
        const worker = async () => {
            while (isOperationActive(operation) && !operation.stopLoadingRequested) {
                const pageNumber = nextPage++;
                if (pageNumber > pagesCount + 1) return;

                const { signal, cleanup } = withTimeout(operation, CONFIG.siteTimeoutMs);
                try {
                    const result = await adapter.loadPage(pageNumber, { ...context, signal });
                    addLoadedCardsToPending(operation, adapter, result.cards);
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
                    updateStatus(operation);
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(siteWorkers, pagesCount) }, () => worker()));
        if (operation.stopLoadingRequested) operation.siteTotal = operation.siteLoaded;
    }

    async function reloadInitialPage(operation, adapter) {
        if (!adapter.reloadInitialPage) return;

        let grid = adapter.getGrid();
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
        } finally {
            cleanup();
            operation.cleanups.delete(cleanup);
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
        setStartButtonLoading(true);
        setStatus('Подготовка...');

        try {
            resetCards(adapter);
            await reloadInitialPage(operation, adapter);
            if (!isOperationActive(operation)) return;

            const pagesCount = Math.max(0, Math.min(999, readNumberInput('pages-input', 0)));
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
                    ? formatResultStats(adapter)
                    : 'Готово. Подходящих карточек нет.';
                finishOperation(operation, resultText);
                showToast(resultText);
                return;
            }

            await runSteamWorkers(operation, adapter, cards);
            if (!isOperationActive(operation)) return;

            sortAndPrune(adapter);
            const resultText = formatResultStats(adapter);
            finishOperation(operation, resultText);
            showToast('Готово!');
        } catch (error) {
            showToast(error.message || 'Ошибка выполнения', 'error');
            finishOperation(operation, error.message || 'Ошибка выполнения');
        }
    }

    /*************************************************************************
     * Boot
     *************************************************************************/

    const observer = new MutationObserver(() => injectPanel());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    injectPanel();
})();
