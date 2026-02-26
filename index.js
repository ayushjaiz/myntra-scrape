import dotenv from "dotenv";
dotenv.config();

import puppeteer from "puppeteer";

// SAVE TO FILE (optional)
import fs from "fs";

/** -----------------------------
 *  Helpers
--------------------------------*/
const selectorMapping = {
  container: ".product-base",
  brand: ".product-brand",
  name: ".product-product",
  price: ".product-discountedPrice",
  ratingsCount: ".product-ratingsCount",
  ratings: ".product-ratingsContainer span",
  url: '[data-refreshpage="true"][target="_blank"]',
  images: ".product-imageSliderContainer img",
};

/** -----------------------------
 *  Scroll to load all lazy images
--------------------------------*/
async function scrollToLoadImages(page) {
  // Scroll through the page slowly to trigger lazy-load observers
  await page.evaluate(async (imgSelector) => {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    // Scroll down in small steps (half-viewport) to ensure every product enters the viewport
    const step = Math.floor(window.innerHeight / 2);
    const maxScroll = () => document.body.scrollHeight - window.innerHeight;

    while (window.scrollY < maxScroll()) {
      window.scrollBy(0, step);
      await delay(400);
    }

    // Second pass — scroll back up to catch anything missed
    while (window.scrollY > 0) {
      window.scrollBy(0, -step);
      await delay(200);
    }

    // Wait for images to finish loading
    const imgs = document.querySelectorAll(imgSelector);
    await Promise.allSettled(
      Array.from(imgs).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 3000); // max 3s per image
        });
      })
    );
  }, selectorMapping.images);

  // Extra network settle time for any remaining image requests
  await new Promise((r) => setTimeout(r, 2000));
}

/** -----------------------------
 *  Extract all products on page
--------------------------------*/
async function getProductsData(page) {
  return await page.$$eval(
    selectorMapping.container,
    (products, selectors) => {
      const parseRatingsCount = (raw = "") => {
        const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
        const match = raw
          .trim()
          .toLowerCase()
          .match(/(\d+(\.\d+)?)([kmb])?/i);
        if (!match) return 0;
        return parseFloat(match[1]) * (multipliers[match[3]] || 1);
      };

      const parsePrice = (raw = "") => {
        let cleaned = raw.replace(/[^0-9.]/g, "").replace(/^\./, "");
        return parseFloat(cleaned) || 0;
      };

      return products.map((product) => {
        const getText = (sel) =>
          product.querySelector(sel)?.innerText?.trim() || "";

        return {
          name: getText(selectors.name),
          brand: getText(selectors.brand),
          price: parsePrice(getText(selectors.price)),
          ratings: parseFloat(getText(selectors.ratings)) || 0,
          ratingsCount: parseRatingsCount(getText(selectors.ratingsCount)),
          url: product.querySelector(selectors.url)?.href || "",
          images: product.querySelectorAll(selectors.images)
            ? Array.from(product.querySelectorAll(selectors.images)).map(
                (img) => {
                  // Try src first, then data-src, then first URL from srcset
                  if (img.src && !img.src.startsWith("data:")) return img.src;
                  if (img.getAttribute("data-src")) return img.getAttribute("data-src");
                  const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
                  const firstUrl = srcset.split(",")[0]?.trim().split(" ")[0];
                  if (firstUrl) return firstUrl;
                  return "";
                }
              ).filter(Boolean)
            : [],
        };
      });
    },
    selectorMapping
  );
}

/** -----------------------------
 *  Scrape a single page
--------------------------------*/
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

async function scrapePage(browser, pageUrl, pageNumber) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  try {
    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    await page.waitForSelector(selectorMapping.container, { timeout: 15_000 });

    await scrollToLoadImages(page);
    const products = await getProductsData(page);

    console.log(`  Page ${pageNumber}: ${products.length} products`);
    return products;
  } catch (err) {
    console.warn(`  Page ${pageNumber} failed: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

/** -----------------------------
 *  Build paginated URL
--------------------------------*/
function buildPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  url.searchParams.set("p", pageNumber);
  return url.toString();
}

/** -----------------------------
 *  Detect total pages available
--------------------------------*/
async function getTotalPages(browser, baseUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60_000 });
    await page.waitForSelector(selectorMapping.container, { timeout: 15_000 });

    // Try to read total count from Myntra's results header
    const totalPages = await page.evaluate(() => {
      // Look for pagination links to find the last page number
      const paginationLinks = document.querySelectorAll(".pagination-paginationMeta");
      for (const el of paginationLinks) {
        const match = el.textContent.match(/Page \d+ of (\d+)/i);
        if (match) return parseInt(match[1]);
      }
      // Fallback: count from .pagination-number elements
      const pageNums = document.querySelectorAll(".pagination-number");
      if (pageNums.length > 0) {
        const last = pageNums[pageNums.length - 1];
        const num = parseInt(last.textContent);
        if (!isNaN(num)) return num;
      }
      return 1;
    });

    await page.close();
    return totalPages;
  } catch {
    await page.close();
    return 1;
  }
}

/** -----------------------------
 *  Main
--------------------------------*/
async function main() {
  const url = process.env.PAGE_URL;
  if (!url) {
    console.error("Missing PAGE_URL in .env");
    process.exit(1);
  }

  const TARGET_COUNT = parseInt(process.env.TARGET_COUNT) || 200;
  if (isNaN(TARGET_COUNT) || TARGET_COUNT <= 0) {
    console.error("Invalid TARGET_COUNT in .env");
    process.exit(1);
  }

  const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 4;

  const browser = await puppeteer.launch();

  // Detect how many pages exist
  console.log("Detecting total pages...");
  const totalPages = await getTotalPages(browser, url);
  // Estimate: Myntra shows ~50 products per page
  const productsPerPage = 50;
  const pagesNeeded = Math.min(totalPages, Math.ceil(TARGET_COUNT / productsPerPage));
  console.log(`Total available: ${totalPages} pages. Will scrape up to ${pagesNeeded} pages (concurrency: ${CONCURRENCY})`);

  let allProducts = [];

  // Process pages in batches of CONCURRENCY
  for (let batchStart = 1; batchStart <= pagesNeeded; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY - 1, pagesNeeded);
    const batchPages = [];
    for (let p = batchStart; p <= batchEnd; p++) {
      batchPages.push(p);
    }

    console.log(`\nScraping batch: pages ${batchStart}-${batchEnd}...`);

    const batchResults = await Promise.all(
      batchPages.map((p) => scrapePage(browser, buildPageUrl(url, p), p))
    );

    for (const products of batchResults) {
      allProducts.push(...products);
    }

    console.log(`  Running total: ${allProducts.length} products`);

    if (allProducts.length >= TARGET_COUNT) {
      allProducts = allProducts.slice(0, TARGET_COUNT);
      break;
    }
  }

  console.log(`\nTotal products collected: ${allProducts.length}`);

  await browser.close();

  const fileName = process.env.FILE_NAME || "products.json";
  const productsDir = "products";

  if (!fs.existsSync(productsDir)) {
    fs.mkdirSync(productsDir);
  }

  const filePath = `${productsDir}/${fileName}`;
  fs.writeFileSync(filePath, JSON.stringify(allProducts, null, 2));
  console.log(`Data saved to ${filePath}`);

  // Update manifest.json with the list of all product files
  const manifestPath = `${productsDir}/manifest.json`;
  let manifest = [];
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      manifest = [];
    }
  }
  if (!manifest.includes(fileName)) {
    manifest.push(fileName);
    manifest.sort();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("Updated manifest.json");
}

main().catch((err) => {
  console.error("Error:", err);
});
