'use strict';

const { createTeamManagementService } = require('../services/teamManagementService');

const teamManagementService = createTeamManagementService();

exports.listOrgUnits = async (req, res, next) => {
  try {
    const orgUnits = await teamManagementService.listOrgUnits({
      authContext: req.authContext,
      status: req.query.status
    });
    return res.json({ orgUnits });
  } catch (error) {
    return next(error);
  }
};

exports.createOrgUnit = async (req, res, next) => {
  try {
    const orgUnit = await teamManagementService.createOrgUnit({
      authContext: req.authContext,
      req,
      input: req.body || {}
    });
    return res.status(201).json({
      message: 'Organization unit created',
      orgUnit
    });
  } catch (error) {
    return next(error);
  }
};

exports.updateOrgUnit = async (req, res, next) => {
  try {
    const orgUnit = await teamManagementService.updateOrgUnit({
      authContext: req.authContext,
      req,
      orgUnitId: req.params.orgUnitId,
      input: req.body || {}
    });
    return res.json({
      message: 'Organization unit updated',
      orgUnit
    });
  } catch (error) {
    return next(error);
  }
};

