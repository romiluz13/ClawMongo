#!/bin/bash
set -e

echo "Starting ClawMongo MongoDB initialization..."

export MONGOT_PASSWORD=${MONGOT_PASSWORD:-mongotPassword}
export ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin}

# Wait for MongoDB to be ready (with timeout)
echo "Waiting for MongoDB to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0
until mongosh --eval "print('MongoDB is ready')" > /dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "ERROR: MongoDB did not become ready after $((MAX_RETRIES * 2)) seconds."
    exit 1
  fi
  echo "Waiting for MongoDB... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  sleep 2
done

echo "MongoDB is ready, proceeding with initialization..."

# Create mongot user for search coordination
# Uses a temporary JS file to avoid shell injection via password values
echo "Creating mongotUser..."
INIT_SCRIPT=$(mktemp /tmp/init-mongo-XXXXXX.js)
cat > "$INIT_SCRIPT" << 'ENDOFSCRIPT'
const adminDb = db.getSiblingDB('admin');
const mongotPwd = process.env.MONGOT_PASSWORD || 'mongotPassword';
try {
  adminDb.createUser({
    user: 'mongotUser',
    pwd: mongotPwd,
    roles: [{ role: 'searchCoordinator', db: 'admin' }]
  });
  print('User mongotUser created successfully');
} catch (error) {
  if (error.code === 11000) {
    print('User mongotUser already exists');
  } else {
    print('Error creating user: ' + error);
    throw error;
  }
}
ENDOFSCRIPT
mongosh --file "$INIT_SCRIPT"
rm -f "$INIT_SCRIPT"

# Create ClawMongo admin user (optional, for authenticated access)
echo "Creating clawmongo admin user..."
ADMIN_SCRIPT=$(mktemp /tmp/init-admin-XXXXXX.js)
cat > "$ADMIN_SCRIPT" << 'ENDOFSCRIPT'
const openclawDb = db.getSiblingDB('openclaw');
const adminPwd = process.env.ADMIN_PASSWORD || 'admin';
try {
  openclawDb.createUser({
    user: 'clawmongo',
    pwd: adminPwd,
    roles: [{ role: 'readWrite', db: 'openclaw' }]
  });
  print('User clawmongo created successfully');
} catch (error) {
  if (error.code === 11000) {
    print('User clawmongo already exists');
  } else {
    print('Warning: Could not create clawmongo user: ' + error);
    throw error;
  }
}
ENDOFSCRIPT
mongosh -u admin -p "$ADMIN_PASSWORD" --authenticationDatabase admin --file "$ADMIN_SCRIPT"
rm -f "$ADMIN_SCRIPT"

echo "ClawMongo MongoDB initialization completed successfully."
