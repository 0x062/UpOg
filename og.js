// Mengimpor modul yang diperlukan
import { ethers } from 'ethers';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk'; // Menggunakan SDK 0G Labs
import dotenv from 'dotenv'; // Untuk memuat variabel dari .env

// --- Inisialisasi Awal ---
dotenv.config(); // Memuat variabel dari file .env

// Logger untuk output yang rapi (tidak berubah)
const colors = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", white: "\x1b[37m",
};
const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  process: (msg) => console.log(`\n${colors.white}[➤] ${msg}${colors.reset}`),
  critical: (msg) => console.log(`${colors.red}[❌] ${msg}${colors.reset}`),
  section: (msg) => console.log(`\n${colors.cyan}${'='.repeat(50)}\n${msg}\n${'='.repeat(50)}${colors.reset}\n`),
  banner: () => console.log(`${colors.cyan}--- 0G Full-Automatic Uploader ---${colors.reset}\n`),
};

// --- Memuat Konfigurasi dari .env ---
const {
    PRIVATE_KEY,
    RPC_URL,
    INDEXER_URL,
    UPLOADS_TO_RUN,
    STORAGE_FEE_IN_ETHER,
    DELAY_MS,
    EXPLORER_URL
} = process.env;

// Validasi konfigurasi
if (!PRIVATE_KEY || !RPC_URL || !INDEXER_URL) {
    logger.critical("Pastikan PRIVATE_KEY, RPC_URL, dan INDEXER_URL ada di file .env");
    process.exit(1);
}

const uploadsCount = parseInt(UPLOADS_TO_RUN, 10) || 1;
const delayMilliseconds = parseInt(DELAY_MS, 10) || 5000;
const storageFee = ethers.parseEther(STORAGE_FEE_IN_ETHER || '0.00084');

// --- Setup Provider & Wallet ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const indexer = new Indexer(INDEXER_URL); // Inisialisasi SDK Indexer

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GENERATED_DIR = path.join(__dirname, 'generated-files');

if (!fs.existsSync(GENERATED_DIR)) {
    fs.mkdirSync(GENERATED_DIR);
}

// --- Fungsi-fungsi Utama ---

function createAxiosInstance() {
    // Disederhanakan, tidak lagi menggunakan proxy
    return axios.create({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        }
    });
}

async function fetchRandomImage() {
    logger.loading('Fetching random image...');
    try {
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get('https://picsum.photos/800/600', {
            responseType: 'arraybuffer',
            maxRedirects: 5
        });
        logger.info('Image fetched successfully.');
        return response.data;
    } catch (error) {
        logger.error(`Error fetching image: ${error.message}`);
        throw error;
    }
}

/**
 * Fungsi ini menggunakan 0G Storage SDK untuk meng-upload file.
 * SDK akan menangani proses upload ke storage node dan mengirim transaksi on-chain.
 */
async function uploadFileWithSDK(imageBuffer) {
    const MAX_RETRIES = 3;
    let attempt = 1;

    while (attempt <= MAX_RETRIES) {
        try {
            logger.loading(`Uploading file with SDK (Attempt ${attempt}/${MAX_RETRIES})...`);

            // 1. Buat instance ZgFile dari buffer gambar
            // SDK akan menghitung hash (root) secara internal
            const file = new ZgFile(imageBuffer);

            // 2. Tentukan opsi untuk upload
            const options = {
                // Biaya on-chain yang dikirim bersama transaksi
                // Dimuat dari .env untuk menghindari hardcode
                value: storageFee, 
                // Opsi lain bisa ditambahkan di sini jika SDK mendukung (misal: gasLimit, gasPrice, dll)
            };

            // 3. Panggil fungsi `upload` dari SDK
            // Ini akan menangani upload ke storage DAN pengiriman transaksi
            const tx = await indexer.upload(file, wallet, options);
            const txLink = `${EXPLORER_URL}${tx.hash}`;
            logger.info(`Transaction sent: ${tx.hash}`);
            logger.info(`Explorer: ${txLink}`);
            
            logger.loading('Waiting for confirmation...');
            const receipt = await tx.wait(); // Menunggu transaksi dikonfirmasi

            if (receipt.status !== 1) {
                throw new Error(`Transaction failed with status ${receipt.status}`);
            }

            logger.info(`Transaction confirmed in block ${receipt.blockNumber}`);
            logger.info(`File uploaded successfully! Root hash: ${file.root}`);
            return receipt;

        } catch (error) {
            logger.error(`Upload attempt ${attempt} failed: ${error.message}`);
            attempt++;
            if (attempt > MAX_RETRIES) {
                throw new Error("Failed to upload file after multiple retries.");
            }
            await new Promise(r => setTimeout(r, 5000)); // Tunggu sebelum mencoba lagi
        }
    }
}

async function main() {
    logger.banner();
    try {
        // Cek koneksi dan saldo wallet
        logger.loading(`Checking connection to ${RPC_URL}...`);
        const network = await provider.getNetwork();
        logger.info(`Connected to network: chainId ${network.chainId}`);
        logger.loading(`Checking balance for wallet: ${wallet.address}`);
        const balance = await provider.getBalance(wallet.address);
        logger.info(`Wallet balance: ${ethers.formatEther(balance)} OG`);

        // Validasi saldo
        if (balance < storageFee) {
            logger.critical(`Insufficient balance. Required > ${ethers.formatEther(storageFee)} OG for storage fee.`);
            return;
        }

        logger.section(`Starting ${uploadsCount} upload(s) for wallet ${wallet.address}`);

        let successful = 0;
        let failed = 0;

        for (let i = 1; i <= uploadsCount; i++) {
            logger.process(`Upload ${i}/${uploadsCount}`);
            try {
                const imageBuffer = await fetchRandomImage();
                await uploadFileWithSDK(imageBuffer);
                successful++;
                logger.info(`Upload ${i} completed successfully.`);
            } catch (error) {
                failed++;
                logger.error(`Upload ${i} failed: ${error.message}`);
            }

            if (i < uploadsCount) {
                logger.loading(`Waiting for ${delayMilliseconds / 1000}s before next upload...`);
                await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
            }
        }

        logger.section('Upload Summary');
        logger.info(`Total tasks: ${uploadsCount}`);
        logger.info(`Successful: ${successful}`);
        logger.error(`Failed: ${failed}`);

    } catch (error) {
        logger.critical(`A critical error occurred: ${error.message}`);
        process.exit(1);
    }
}

main();
