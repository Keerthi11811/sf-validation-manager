const express = require('express');
const cors = require('cors');
require('dotenv').config(); 

const app = express();

// Global CORS configurations for modern browser network pipelines
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).send(); 
    }
    next();
});

app.use(express.json());

const PORT = 5000;

// Step 1: Exchange Authorization Code for Access Token
app.post('/api/oauth/callback', async (req, res) => {
    const { code } = req.body;
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        redirect_uri: process.env.SF_REDIRECT_URI
    });

    console.log("--- Executing Token Exchange ---");
    try {
        const response = await fetch('https://login.salesforce.com/services/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            console.error("❌ Salesforce Auth Error Payload:", data);
            return res.status(400).json(data);
        }
        console.log("✅ Token successfully retrieved!");
        res.json({ accessToken: data.access_token, instanceUrl: data.instance_url });
    } catch (err) {
        console.error("💥 Backend Crash at /api/oauth/callback:", err);
        res.status(500).json({ error: err.message });
    }
});

// Step 2: Fetch Validation Rules via Tooling API (Bulk Safe List)
app.post('/api/rules/fetch', async (req, res) => {
    const { accessToken, instanceUrl } = req.body;
    const query = `SELECT Id, ValidationName, Active, Description, ErrorMessage FROM ValidationRule WHERE EntityDefinitionId='Account'`;
    
    console.log("--- Fetching Validation Rules ---");
    try {
        const response = await fetch(`${instanceUrl}/services/data/v60.0/tooling/query/?q=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await response.json();
        if (!response.ok) {
            console.error("❌ Salesforce Tooling API Query Error:", data);
            return res.status(response.status).json(data);
        }
        const mappedRecords = (data.records || []).map(record => ({
            Id: record.Id,
            ValidationName: record.ValidationName,
            Active: record.Active,
            Description: record.Description || "No description provided.",
            ErrorMessage: record.ErrorMessage || "Field input validation error.",
            ErrorConditionFormula: ""
        }));
        console.log(`✅ Successfully fetched ${mappedRecords.length} rules.`);
        res.json(mappedRecords);
    } catch (err) {
        console.error("💥 Backend Crash at /api/rules/fetch:", err);
        res.status(500).json({ error: err.message });
    }
});

// Step 3: Deploy/Toggle Validation Rule State (With Strict Key and Namespace Rules)
app.post('/api/rules/update-post', async (req, res) => {
    const { accessToken, instanceUrl, ruleId, active } = req.body;

    console.log(`\n--- Deploying Metadata Payload for Validation Rule: ${ruleId} ---`);
    try {
        const singleQuery = `SELECT ValidationName, Description, ErrorMessage, Metadata FROM ValidationRule WHERE Id = '${ruleId}'`;
        const fetchResponse = await fetch(`${instanceUrl}/services/data/v60.0/tooling/query/?q=${encodeURIComponent(singleQuery)}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!fetchResponse.ok) {
            return res.status(400).json({ error: "Salesforce pre-check failed to load rule structure." });
        }

        const queryData = await fetchResponse.json();
        if (!queryData.records || queryData.records.length === 0) {
            return res.status(404).json({ error: "Rule not found in Salesforce org." });
        }

        const originalRule = queryData.records[0];
        const sfMetadata = originalRule.Metadata || originalRule.metadata || {};
        
        const formulaText = sfMetadata.errorConditionFormula || "";
        const errorMessageText = originalRule.ErrorMessage || sfMetadata.errorMessage || "Field validation error.";
        const descriptionText = originalRule.Description || sfMetadata.description || "";

        // Construct standard namespace dot notation required for metadata processing
        const ruleFullName = `Account.${originalRule.ValidationName}`;

        const payload = {
            FullName: ruleFullName, 
            Metadata: {
                active: active,
                description: descriptionText,
                errorConditionFormula: formulaText,
                errorMessage: errorMessageText
            }
        };

        console.log(`📤 Pushing Complete Tooling Metadata Payload:`, JSON.stringify(payload, null, 2));

        const response = await fetch(`${instanceUrl}/services/data/v60.0/tooling/sobjects/ValidationRule/${ruleId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.status === 204) {
            console.log(`✅ Success! Validation rule metadata deployed cleanly.`);
            return res.json({ success: true });
        } else {
            const errData = await response.json();
            console.error("❌ Salesforce Tooling API Rejection Log:", JSON.stringify(errData, null, 2));
            const concreteReason = errData?.[0]?.message || errData?.message || "Metadata payload parsing error.";
            return res.status(400).json({ error: concreteReason });
        }
    } catch (err) {
        console.error("💥 Critical Backend Crash:", err.stack);
        return res.status(500).json({ error: err.message });
    }
});

const path = require('path');

// Route Node to look inside the compiled React workspace folder
app.use(express.static(path.join(__dirname, '../client/build')));

// Wildcard fallback: Any random URL routing defaults to your React interface home screen
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});
app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));