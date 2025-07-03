const fs = require('fs');
const path = require('path');

// Function to recursively find and delete files
function deleteFiles(dir, patterns) {
    if (!fs.existsSync(dir)) return;
    
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            deleteFiles(filePath, patterns);
        } else {
            // Check if file matches any pattern
            const shouldDelete = patterns.some(pattern => {
                if (typeof pattern === 'string') {
                    return file.includes(pattern);
                } else if (pattern instanceof RegExp) {
                    return pattern.test(file);
                }
                return false;
            });
            
            if (shouldDelete) {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted: ${filePath}`);
                } catch (err) {
                    console.warn(`Could not delete: ${filePath}`, err.message);
                }
            }
        }
    });
}

// Patterns to match problematic files
const patterns = [
    'test_key.pem',
    'test_rsa_privkey.pem', 
    'test_rsa_pubkey.pem',
    /.*test.*\.pem$/,
    /test_.*\.js$/
];

console.log('Cleaning test files and PEM keys...');

// Clean node_modules
deleteFiles(path.join(__dirname, 'node_modules'), patterns);

// Clean any test directories
const testDirs = [
    path.join(__dirname, 'node_modules', 'public-encrypt', 'test'),
    path.join(__dirname, 'node_modules', 'crypto-browserify', 'test')
];

testDirs.forEach(dir => {
    if (fs.existsSync(dir)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`Removed test directory: ${dir}`);
        } catch (err) {
            console.warn(`Could not remove directory: ${dir}`, err.message);
        }
    }
});

console.log('Cleanup complete!'); 